import type { WebClient } from "@slack/web-api";
import { prisma } from "../lib/prisma.js";
import { getResolver } from "../lib/tools.js";
import { syncTicketReaction } from "../lib/slack.js";
import type { Ticket, SlackUser } from "../generated/prisma/client.js";
import { RESOLVE_MACROS, isMacroCommand } from "../lib/constants.js";
import type { FlaronUserResponse } from "../lib/types.js";

export type TicketWithAssignees = Ticket & { assignees: SlackUser[] };

function getMessageAuthorId(
  message:
    | { user?: string; bot_id?: string; app_id?: string }
    | undefined,
): string | undefined {
  return message?.user ?? message?.bot_id ?? message?.app_id;
}

export async function createUser(client: WebClient, id: string) {
  let effectiveId = id;
  let username: string | undefined;
  let isBot = false;

  // Bot IDs start with B and do not work with users.info. Resolve them to the
  // underlying bot user ID when possible, otherwise keep the bot ID.
  if (id.startsWith("B")) {
    try {
      const botInfo = await client.bots.info({ bot: id });
      if (botInfo.bot?.user_id) {
        effectiveId = botInfo.bot.user_id;
      }
      username = botInfo.bot?.name ?? undefined;
      isBot = true;
    } catch (_e) {
      console.warn(`WARNING: bots.info failed for ${id}, using bot id directly`);
      isBot = true;
    }
  }

  let dbUser = await prisma.slackUser.findUnique({
    where: {
      id: effectiveId,
    },
  });

  // If bots.info already gave us a name, skip the external user lookups.
  if (!username) {
    const flaronUser = await fetch(
      `https://flaron.halceon.dev/user/${effectiveId}`,
    );
    if (flaronUser && flaronUser.ok) {
      try {
        const respJson = (await flaronUser.json()) as FlaronUserResponse;
        if (respJson.data?.user) {
          isBot = respJson.data.user.is_bot ?? false;
          if (
            respJson.data.user.display_name &&
            respJson.data.user.display_name.length > 0
          ) {
            username = respJson.data.user.display_name;
          } else if (
            respJson.data.user.real_name &&
            respJson.data.user.real_name.length > 0
          ) {
            username = respJson.data.user.real_name;
          } else if (
            respJson.data.user.name &&
            respJson.data.user.name.length > 0
          ) {
            username = respJson.data.user.name;
          }
        } else {
          console.warn(
            `WARNING: Flaron returned no user data for ${effectiveId}`,
          );
        }
      } catch (e) {
        console.warn(
          `WARNING: Failed to parse Flaron response for ${effectiveId}`,
          e,
        );
      }
    }

    if (!username) {
      console.warn(
        `WARNING: Flaron lookup failed for ${effectiveId}, falling back to slack lookup`,
      );
      try {
        const slackUser = await client.users.info({
          user: effectiveId,
        });
        isBot = slackUser.user?.is_bot ?? false;
        if (
          slackUser.user?.profile?.display_name &&
          slackUser.user?.profile?.display_name.length > 0
        ) {
          username = slackUser.user.profile.display_name;
        } else if (
          slackUser.user?.real_name &&
          slackUser.user?.real_name.length > 0
        ) {
          username = slackUser.user.real_name;
        } else if (slackUser.user?.name && slackUser.user?.name.length > 0) {
          username = slackUser.user.name;
        }
      } catch (e) {
        console.warn(`WARNING: Slack lookup failed for ${effectiveId}`, e);
      }
    }
  }

  if (!username) {
    username = isBot ? "Unknown bot" : "Unknown user";
  }

  if (!dbUser) {
    dbUser = await prisma.slackUser.create({
      data: {
        id: effectiveId,
        username: username,
        isBot: isBot,
      },
    });
  } else {
    console.log("Updating Slack user details for ", dbUser.id);
    dbUser = await prisma.slackUser.update({
      where: {
        id: effectiveId,
      },
      data: {
        username: username,
        isBot: isBot,
      },
    });
  }
  return dbUser;
}
export async function indexThread(
  client: WebClient,
  programId: string,
  channel: string,
  threadTs: string,
) {
  const program = await prisma.program.findUnique({
    where: {
      id: programId,
    },
  });
  if (!program) return;
  const thread = await client.conversations.replies({
    channel: channel,
    ts: threadTs,
  });
  if (!thread.messages) return;

  // this was geenrated with claude code because slack doesn't expose pinned messages for some reason?
  const rootMessage = thread.messages[0] as
    | ((typeof thread.messages)[number] & { pinned_to?: string[] })
    | undefined;
  if (rootMessage?.pinned_to && rootMessage.pinned_to.length > 0) {
    console.log(`Skipping pinned message ${threadTs}`);
    return;
  }
  // end of claude code

  const existingTicket = await prisma.ticket.findFirst({
    where: {
      messageId: threadTs as string,
    },
    include: {
      assignees: true,
    },
  });

  let ticket: TicketWithAssignees;
  if (existingTicket) {
    ticket = existingTicket;
  } else {
    const ticketAuthor = await createUser(
      client,
      getMessageAuthorId(thread.messages[0]) as string,
    );
    ticket = (await prisma.ticket.create({
      data: {
        messageId: threadTs,
        programId: programId,
        message: (thread.messages[0]?.text as string) ?? null,
        dateCreated: new Date(
          parseFloat(thread.messages[0]?.ts as string) * 1000,
        ),
        slackUserId: ticketAuthor.id,
      },
      include: {
        assignees: true,
      },
    })) as TicketWithAssignees;
    console.log(
      `Indexed ticket from ${new Date(ticket.dateCreated).toLocaleString()}`,
    );
    await syncTicketReaction(
      client,
      channel,
      ticket.messageId,
      ticket.status,
    );
  }

  let assignedFirst = false;
  for (let i = 0; i < thread.messages.length; i++) {
    let replyAuthor: SlackUser | undefined;
    const authorId = getMessageAuthorId(thread.messages[i]);
    try {
      replyAuthor = await createUser(client, authorId as string);
    } catch (e) {
      console.error("Error creating user ", authorId);
      console.error(e);
      console.error("Thread message: ", thread.messages[i]);
    }
    if (i > 0) {
      if (isMacroCommand(thread.messages[i]?.text ?? "")) continue;

      if (!replyAuthor) {
        console.error(
          "Skipping reply without an author: ",
          thread.messages[i]?.ts,
        );
        continue;
      }

      let r;
      try {
        r = await prisma.reply.upsert({
          where: {
            messageId: thread.messages[i]?.ts as string,
          },
          update: {},
          create: {
            ticketId: ticket.id,
            messageId: thread.messages[i]?.ts as string,
            message: thread.messages[i]?.text ?? "",
            dateCreated: new Date(
              parseFloat(thread.messages[i]?.ts as string) * 1000,
            ),
            slackUserId: replyAuthor.id,
          },
          include: {
            slackUser: {
              include: {
                programs: true,
              },
            },
            ticket: true,
          },
        });

        console.log(
          `Indexed reply from ${new Date(r.dateCreated).toLocaleString()}`,
        );
      } catch (e) {
        console.error(
          "Error indexing reply ",
          thread.messages[i]?.ts as string,
        );
        console.error(e);
        console.error("Reply info: ", thread.messages[i]);
        console.error("Ticket info: ", ticket);
        continue;
      }
      if (thread.messages[i]?.user === process.env["BOT_USER_ID"]) {
        console.log("bot!!!")
      }
      if (
        r.slackUser.programs.some((p) => p.id === programId) &&
        !ticket.responseTime
      ) {
        ticket = (await prisma.ticket.update({
          where: {
            id: ticket.id,
          },
          data: {
            responseTime: Number(r.messageId) - Number(r.ticket.messageId),
          },
          include: {
            assignees: true,
          },
        })) as TicketWithAssignees;
      }
      if (
        RESOLVE_MACROS.some((m) =>
          r.message.toLowerCase().includes(m.keyword.toLowerCase()),
        ) &&
        r.slackUser.isBot &&
        r.slackUser.id === program.supportBotId
      ) {
        // resolve the ticket anonymously
        try {
          ticket = (await prisma.ticket.update({
            where: {
              id: ticket.id,
            },
            data: {
              status: 2,
              resolveTime: Number(r.messageId) - Number(r.ticket.messageId),
              resolveDate: r.dateCreated,
            },
            include: {
              assignees: true,
            },
          })) as TicketWithAssignees;
        } catch (e) {
          console.error("Problem resolving from macro: ", e);
          console.error("Occurred on ticket ", ticket.id);
          console.error("Reply: ", r);
        }
      }
      if (
        r.slackUser.isBot &&
        (program.managed || r.slackUser.id === program.supportBotId) &&
        r.message.includes(program.resolveKeyword)
      ) {
        let resolver = null;
        try {
          resolver = await getResolver(r.message);
        } catch (e) {
          console.error("Error finding resolver: ", e);
          console.error("Reply: ", r);
          console.error("Ticket: ", ticket);
        }
        try {
          const resolverData =
            resolver?.id && resolver.id !== process.env["RESOLVER_USER_ID"]
              ? { resolverId: resolver.id }
              : {};
          ticket = (await prisma.ticket.update({
            where: {
              id: ticket.id,
            },
            data: {
              ...resolverData,
              status: 2,
              resolveTime: Number(r.messageId) - Number(r.ticket.messageId),
              resolveDate: r.dateCreated,
            },
            include: {
              assignees: true,
            },
          })) as TicketWithAssignees;
        } catch (e) {
          console.error("Problem resolving ticket: ", e);
          console.error("Resolver: ", resolver);
          console.error("Occurred on ticket ", ticket.id);
          console.error("Reply: ", r);
        }
      }
      if (
        r.slackUser.id === process.env["RESOLVER_USER_ID"] &&
        r.message.includes("Marked as resolved")
      ) {
        let resolver = null;
        try {
          resolver = await getResolver(r.message);
        } catch (e) {
          console.error("Error finding resolver: ", e);
          console.error("Reply: ", r);
          console.error("Ticket: ", ticket);
        }
        if (!resolver) continue;
        try {
          ticket = (await prisma.ticket.update({
            where: {
              id: ticket.id,
            },
            data: {
              resolverId: resolver.id,
              status: 2,
              resolveTime: Number(r.messageId) - Number(r.ticket.messageId),
              resolveDate: r.dateCreated,
            },
            include: {
              assignees: true,
            },
          })) as TicketWithAssignees;
        } catch (e) {
          console.error("Problem assigning a resolver: ", e);
          console.error("Resolver: ", resolver);
          console.error("Occurred on ticket ", ticket.id);
          console.error("Reply: ", r);
        }
      }
      if (
        ((r.slackUser.isBot &&
          (program.managed || r.slackUser.id === program.supportBotId)) ||
          r.slackUser.id === process.env["RESOLVER_USER_ID"]) &&
        r.message.includes("reopened")
      ) {
        let resolver = null;
        try {
          resolver = await getResolver(r.message);
        } catch (e) {
          console.error("Error finding resolver: ", e);
          console.error("Reply: ", r);
          console.error("Ticket: ", ticket);
        }
        if (resolver && resolver.id === process.env["RESOLVER_USER_ID"])
          continue; // skip any resolver messages with resolver ID
        try {
          ticket = (await prisma.ticket.update({
            where: {
              id: ticket.id,
            },
            data: {
              resolver: {
                disconnect: true,
              },
              resolveTime: 0,
              status: ticket.assignees.length > 0 ? 1 : 0,
              resolveDate: null,
            },
            include: {
              assignees: true,
            },
          })) as TicketWithAssignees;
        } catch (e) {
          console.error("Problem reopening: ", e);
          console.error("Occurred on ticket ", ticket.id);
        }
      }
      if (
        r.slackUser.programs.some((p) => p.id === programId) &&
        ticket.status !== 2
      ) {
        if (!assignedFirst) {
          // first user that responded!!
          assignedFirst = true;
          ticket = (await prisma.ticket.update({
            where: {
              id: ticket.id,
            },
            data: {
              firstResponseUserId: r.slackUserId,
              assignDate: r.dateCreated,
            },
            include: {
              assignees: true,
            },
          })) as TicketWithAssignees;
        }
        try {
          ticket = (await prisma.ticket.update({
            where: {
              id: ticket.id,
            },
            data: {
              assignees: {
                connect: [{ id: r.slackUserId }],
              },
              status: 1,
            },
            include: {
              assignees: true,
            },
          })) as TicketWithAssignees;
        } catch (e) {
          console.error("Problem assigning an assignee: ", e);
          console.error("Occurred on ticket ", ticket.id);
        }
      }
    }
  } // end execution on every reply

  await syncTicketReaction(client, channel, ticket.messageId, ticket.status);
}
export async function reindexTicket(
  client: WebClient,
  ticketId: string,
  actorId?: string,
) {
  // ai generated as this is for admins only
  const ticket = await prisma.ticket.findUnique({
    where: {
      id: ticketId,
    },
    include: {
      program: true,
    },
  });
  if (!ticket) throw new Error("TICKET_NOT_FOUND");

  // fetch the thread first so nothing gets wiped if Slack is unreachable
  const thread = await client.conversations.replies({
    channel: ticket.program.channelId,
    ts: ticket.messageId,
  });
  if (!thread.messages || thread.messages.length === 0)
    throw new Error("THREAD_NOT_FOUND");

  const rootMessage = thread.messages[0] as
    | ((typeof thread.messages)[number] & { pinned_to?: string[] })
    | undefined;
  if (rootMessage?.pinned_to && rootMessage.pinned_to.length > 0) {
    throw new Error("THREAD_IS_PINNED");
  }

  console.log(
    `Reindexing ticket ${ticket.id} (requested by ${actorId ?? "unknown user"})`,
  );

  // wipe everything that was indexed from Slack so the thread can be rebuilt from scratch
  await createUser(client, getMessageAuthorId(rootMessage) as string);
  await prisma.reply.deleteMany({
    where: {
      ticketId: ticket.id,
    },
  });
  await prisma.ticket.update({
    where: {
      id: ticket.id,
    },
    data: {
      message: (rootMessage?.text as string) ?? null,
      status: 0,
      responseTime: 0,
      resolveTime: 0,
      resolveDate: null,
      assignDate: null,
      resolver: {
        disconnect: true,
      },
      firstResponseUser: {
        disconnect: true,
      },
      assignees: {
        set: [],
      },
    },
  });

  await indexThread(
    client,
    ticket.programId,
    ticket.program.channelId,
    ticket.messageId,
  );
}
export async function addAsHelper(
  slackId: string,
  programId: string,
  client: WebClient,
) {
  const user = await createUser(client, slackId);
  if (user.isBot) {
    console.log(`Skipping bot ${slackId} for program ${programId}`);
    return;
  }
  await prisma.slackUser.update({
    where: {
      id: slackId,
    },
    data: {
      programs: {
        connect: {
          id: programId,
        },
      },
    },
  });
}

export async function indexUsersFromUserGroup(
  groupId: string,
  programId: string,
  client: WebClient,
) {
  const users = await client.usergroups.users.list({
    usergroup: groupId,
  });
  if (!users || !users.users) return;
  for (let i = 0; i < users.users.length; i++) {
    try {
      console.log("Adding ", users.users[i]!, " to ", programId);
      await addAsHelper(users.users[i]!, programId, client);
    } catch (e) {
      console.error(e);
      console.warn(`could not add user ${users.users[i]}`);
    }
  }
}
export async function indexUsersFromChannel(
  channelId: string,
  programId: string,
  client: WebClient,
) {
  const users = await client.conversations.members({
    channel: channelId,
    limit: 100,
  });
  if (!users || !users.members) return;
  for (let i = 0; i < users.members.length; i++) {
    try {
      console.log("Adding ", users.members[i]!, " to ", programId);
      await addAsHelper(users.members[i]!, programId, client);
    } catch (e) {
      console.error(e);
      console.warn(`could not add user ${users.members[i]}`);
    }
  }
}
