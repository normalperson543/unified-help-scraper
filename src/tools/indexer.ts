import type { WebClient } from "@slack/web-api";
import { prisma } from "../lib/prisma";
import { getResolver } from "../lib/tools";

export async function createUser(client: WebClient, id: string) {
  const user = await prisma.slackUser.findUnique({
    where: {
      id: id as string,
    },
  });
  if (!user) {
    const slackUser = await client.users.info({
      user: id as string,
    });
    await prisma.slackUser.create({
      data: {
        id: id as string,
        username:
          slackUser.user?.real_name ?? slackUser.user?.name ?? "Unknown user",
        isBot: slackUser.user?.is_bot ?? false,
      },
    });
  }
}
export async function indexThread(
  client: WebClient,
  program: string,
  channel: string,
  threadTs: string,
) {
  const thread = await client.conversations.replies({
    channel: channel,
    ts: threadTs,
  });
  if (!thread.messages) return;

  // this was geenrated with claude code because slack doesn't expose pinned messages for some reason?
  const rootMessage = thread.messages[0] as
    ((typeof thread.messages)[number] & { pinned_to?: string[] }) | undefined;
  if (rootMessage?.pinned_to && rootMessage.pinned_to.length > 0) {
    console.log(`Skipping pinned message ${threadTs}`);
    return;
  }
  // end of claude code

  let ticket = await prisma.ticket.findFirst({
    where: {
      messageId: threadTs as string,
    },
    include: {
      assignees: true,
    },
  });
  console.log(thread.messages[0]);
  if (!ticket) {
    await createUser(client, thread.messages[0]?.user as string);
    ticket = await prisma.ticket.create({
      data: {
        messageId: threadTs,
        programId: program,
        message: (thread.messages[0]?.text as string) ?? null,
        dateCreated: new Date(
          parseFloat(thread.messages[0]?.ts as string) * 1000,
        ),
        slackUserId: thread.messages[0]?.user as string,
      },
      include: {
        assignees: true,
      },
    });
    console.log(
      `Indexed ticket from ${new Date(ticket.dateCreated).toLocaleString()}`,
    );
  }

  let assignedFirst = false;
  for (let i = 0; i < thread.messages.length; i++) {
    try {
      await createUser(
        client,
        (thread.messages[i]?.user as string) ??
          thread.messages[i]?.bot_id ??
          thread.messages[i]?.app_id,
      );
    } catch (e) {
      console.error("Error creating user ", thread.messages[i]?.user as string);
      console.error(e);
      console.error("Thread message: ", thread.messages[i]);
    }
    if (i > 0) {
      let r = await prisma.reply.findFirst({
        where: {
          messageId: thread.messages[i]?.ts as string,
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
      if (!r) {
        try {
          r = await prisma.reply.create({
            data: {
              ticketId: ticket!.id,
              messageId: thread.messages[i]?.ts as string,
              message: thread.messages[i]?.text ?? "",
              dateCreated: new Date(
                parseFloat(thread.messages[i]?.ts as string) * 1000,
              ),
              slackUserId: thread.messages[i]?.user as string,
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
      }
      console.log("resp times");
      console.log(r.messageId);
      console.log(r.ticket.messageId);
      if (
        r.slackUser.programs.some((p) => p.id === program) &&
        !ticket.responseTime
      ) {
        console.log("okay go");
        ticket = await prisma.ticket.update({
          where: {
            id: ticket.id!,
          },
          data: {
            responseTime: Number(r.messageId) - Number(r.ticket.messageId),
          },
          include: {
            assignees: true,
          },
        });
      }
      if (
        r.slackUser.isBot &&
        (r.message.includes("marked as resolved") ||
          r.message.includes("marked resolved"))
      ) {
        const resolver = await getResolver(r.message);
        try {
          ticket = await prisma.ticket.update({
            where: {
              id: ticket.id,
            },
            data: {
              resolverId: resolver?.id ?? "",
              status: 2,
              resolveTime: Number(r.messageId) - Number(r.ticket.messageId),
            },
            include: {
              assignees: true,
            },
          });
        } catch (e) {
          console.error("Problem assigning a resolver: ", e);
          console.error("Resolver: ", resolver);
          console.error("Occurred on ticket ", ticket.id);
          console.error("Reply: ", r);
        }
      }
      if (r.slackUser.isBot && r.message.includes("reopened")) {
        try {
          ticket = await prisma.ticket.update({
            where: {
              id: ticket.id,
            },
            data: {
              resolver: {
                disconnect: true,
              },
              resolveTime: 0,
              status: ticket.assignees.length > 0 ? 1 : 0,
            },
            include: {
              assignees: true,
            },
          });
        } catch (e) {
          console.error("Problem reopening: ", e);
          console.error("Occurred on ticket ", ticket.id);
        }
      }
      console.log(r.slackUser.programs);
      if (
        r.slackUser.programs.some((p) => p.id === program) &&
        ticket.status !== 2
      ) {
        if (!assignedFirst) {
          // first user that responded!!
          assignedFirst = true;
          ticket = await prisma.ticket.update({
            where: {
              id: ticket.id,
            },
            data: {
              firstResponseUserId: r.slackUserId,
            },
            include: {
              assignees: true,
            },
          });
        }
        try {
          ticket = await prisma.ticket.update({
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
          });
        } catch (e) {
          console.error("Problem assigning an assignee: ", e);
          console.error("Occurred on ticket ", ticket.id);
        }
      }
    }
  }
}
export async function addAsHelper(
  slackId: string,
  programId: string,
  client: WebClient,
) {
  await createUser(client, slackId);
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
  // todo: move this to the scraper
  const users = await client.usergroups.users.list({
    usergroup: groupId,
  });
  if (!users || !users.users) return;
  for (let i = 0; i < users.users.length; i++) {
    try {
      await addAsHelper(users.users[i]!, programId, client);
    } catch (e) {
      console.error(e);
      console.warn(`could not add user ${users.users[i]}`);
    }
  }
}
