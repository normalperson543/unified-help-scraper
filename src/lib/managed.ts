import type {
  GenericMessageEvent,
  FileShareMessageEvent,
  WebClient,
} from "@slack/web-api";
import { createUser, indexThread } from "../tools/indexer.js";
import type { TicketWithAssignees } from "./types.js";
import { prisma } from "./prisma.js";
import { syncTicketReaction } from "./slack.js";
import {
  getManagedProgramMacro,
  type ManagedProgramMacro,
} from "./constants.js";
import { getHangTime, humanizeDuration } from "./tools.js";
import type { Program } from "../generated/prisma/client.js";

export async function resolveManagedTicket(
  client: WebClient,
  messageTs: string,
  ticketId: string,
  resolverId: string,
  resolveTime: number,
  resolveDate: Date,
) {
  const ticket = await prisma.ticket.findUnique({
    where: {
      id: ticketId,
    },
    include: {
      program: true,
    },
  });
  if (!ticket) throw new Error("No ticket found");
  await createUser(client, resolverId);
  const resolverUser = await prisma.slackUser.findUnique({
    where: {
      id: resolverId,
    },
    include: {
      programs: true,
    },
  });
  console.log("test");
  if (
    !resolverUser?.programs.some((p) => p.id === ticket.program.id) &&
    resolverId !== ticket.slackUserId
  ) {
    await client.chat.postEphemeral({
      channel: ticket.program.channelId,
      user: resolverId,
      thread_ts: ticket.messageId,
      username: ticket.program.supportBotName,
      icon_url: ticket.program.logo ?? "",
      text: ":neocat_confused: Sorry, you can't resolve this ticket as it's not yours.",
    });
    return;
  }
  if (ticket.status === 2) {
    await client.chat.postEphemeral({
      channel: ticket.program.channelId,
      user: resolverId,
      thread_ts: ticket.messageId,
      username: ticket.program.supportBotName,
      icon_url: ticket.program.logo ?? "",
      text: ":neocat_confused: This ticket has already been resolved.",
    });
    return;
  }

  const updatedTicket = (await prisma.ticket.update({
    where: { id: ticket.id },
    data: {
      status: 2,
      resolverId: resolverId,
      resolveTime: resolveTime,
      resolveDate: resolveDate,
    },
    include: { assignees: true },
  })) as TicketWithAssignees;

  await syncTicketReaction(
    client,
    ticket.program.channelId,
    ticket.messageId,
    updatedTicket.status,
  );
  try {
    await client.chat.postMessage({
      channel: ticket.program.channelId,
      thread_ts: messageTs,
      username: ticket.program.supportBotName,
      icon_url: ticket.program.logo ?? "",
      text: `<@${resolverId}> marked this as resolved.`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: ticket.program.resolveMessage.replace(
              "{USERNAME}",
              `<@${resolverId}>`,
            ),
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Reopen",
                emoji: true,
              },
              value: ticket.id,
              action_id: "reopen",
              style: "primary",
            },
          ],
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `<https://unified.help.hackclub.com/programs/${ticket.programId}/ticket/${updatedTicket.id}|backend> (for support team).`,
            },
          ],
        },
      ],
      unfurl_links: false,
    });
    await indexThread(
      // run a reindex
      client,
      ticket.program.id,
      ticket.program.channelId,
      ticket.messageId,
    );
  } catch (e) {
    console.error("Failed to post resolve reply: ", e);
  }
}

export async function resolveWithMacro(
  client: WebClient,
  ticketId: string,
  macro: ManagedProgramMacro,
  resolveTime: number,
  resolveDate: Date,
  threadTs: string,
) {
  const ticket = await prisma.ticket.findUnique({
    where: {
      id: ticketId,
    },
    include: {
      program: true,
    },
  });
  if (!ticket) throw new Error("No ticket found");

  const ticketAuthor = await prisma.slackUser.findUnique({
    where: { id: ticket.slackUserId },
  });
  const expandedMessage = macro.message.replace(
    "{USERNAME}",
    ticketAuthor?.username ?? "there",
  );

  await prisma.ticket.update({
    where: { id: ticket.id },
    data: {
      status: 2,
      resolveTime: resolveTime,
      resolveDate: resolveDate,
    },
  });

  await syncTicketReaction(
    client,
    ticket.program.channelId,
    ticket.messageId,
    2,
  );

  await client.chat.postMessage({
    channel: ticket.program.channelId,
    thread_ts: threadTs,
    username: ticket.program.supportBotName,
    icon_url: ticket.program.logo ?? "",
    text: expandedMessage,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: expandedMessage },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Reopen", emoji: true },
            value: ticket.id,
            action_id: "reopen",
            style: "primary",
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `<https://unified.help.hackclub.com/programs/${ticket.programId}/ticket/${ticket.id}|backend> (for support team).`,
          },
        ],
      },
    ],
    unfurl_links: false,
  });
  await indexThread(
    client,
    ticket.program.id,
    ticket.program.channelId,
    ticket.messageId,
  );
}

export async function reopenManagedTicket(
  client: WebClient,
  ticketId: string,
  threadTs: string,
  authorId: string,
) {
  const ticket = await prisma.ticket.findUnique({
    where: {
      id: ticketId,
    },
    include: {
      program: true,
      assignees: true,
    },
  });
  if (!ticket) throw new Error("No ticket found");

  await createUser(client, authorId);
  const reopenerUser = await prisma.slackUser.findUnique({
    where: {
      id: authorId,
    },
    include: {
      programs: true,
    },
  });
  if (
    !reopenerUser?.programs.some((p) => p.id === ticket.program.id) &&
    authorId !== ticket.slackUserId
  ) {
    await client.chat.postEphemeral({
      channel: ticket.program.channelId,
      user: authorId,
      thread_ts: ticket.messageId,
      username: ticket.program.supportBotName,
      icon_url: ticket.program.logo ?? "",
      text: ":neocat_confused: Sorry, you can't reopen this ticket as it's not yours.",
    });
    return;
  }
  if (ticket.status !== 2) {
    await client.chat.postEphemeral({
      channel: ticket.program.channelId,
      user: authorId,
      thread_ts: ticket.messageId,
      username: ticket.program.supportBotName,
      icon_url: ticket.program.logo ?? "",
      text: ":neocat_confused: This ticket isn't resolved yet, so you can't reopen it.",
    });
    return;
  }
  const updatedTicket = (await prisma.ticket.update({
    where: { id: ticket.id },
    data: {
      resolver: { disconnect: true },
      resolveTime: 0,
      status: ticket.assignees.length > 0 ? 1 : 0,
      resolveDate: null,
    },
    include: { assignees: true },
  })) as TicketWithAssignees;

  await syncTicketReaction(
    client,
    ticket.program.channelId,
    ticket.messageId,
    updatedTicket.status,
  );

  const hangTime = await getHangTime(
    ticket.program.id,
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    new Date(),
  );

  await client.chat.postMessage({
    channel: ticket.program.channelId,
    thread_ts: threadTs,
    username: ticket.program.supportBotName,
    icon_url: ticket.program.logo ?? "",
    text: `This ticket was reopened by <@${authorId}>.`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `This ticket was reopened by <@${authorId}>. To close it, click Resolve.`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Resolve", emoji: true },
            value: updatedTicket.id,
            action_id: "resolve",
            style: "primary",
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Your estimated wait time is ${humanizeDuration(
              hangTime?.median ?? 0,
            )} -  <https://unified.help.hackclub.com/programs/${ticket.programId}/ticket/${updatedTicket.id}|backend> (for support team).`,
          },
        ],
      },
    ],
    unfurl_links: false,
  });
  await indexThread(
    // run a reindex
    client,
    ticket.program.id,
    ticket.program.channelId,
    ticket.messageId,
  );
}

export async function handleManagedProgramMacro(
  client: WebClient,
  program: { id: string; channelId: string; managed: boolean },
  message: { user?: string; thread_ts?: string; ts?: string; text?: string },
): Promise<boolean> {
  // most of this is AI generated
  if (
    !program.managed ||
    !message.text ||
    !message.text.trim().startsWith("?")
  ) {
    return false;
  }

  const macro = getManagedProgramMacro(message.text);
  if (!macro) return false;

  const authorId = message.user;
  const threadTs = message.thread_ts;
  const messageTs = message.ts;
  if (!authorId || !threadTs || !messageTs) return false;

  const ticket = await prisma.ticket.findFirst({
    where: { messageId: threadTs, programId: program.id },
    include: { program: true, assignees: true },
  });
  if (!ticket) return false;

  await createUser(client, authorId);
  const author = await prisma.slackUser.findUnique({
    where: { id: authorId },
    include: { programs: true },
  });
  if (!author?.programs.some((p) => p.id === program.id)) {
    // Not a helper — ignore the macro command.
    return false;
  }

  const actionTs = messageTs;

  try {
    if (macro.action === "reopen") {
      await reopenManagedTicket(client, ticket.id, threadTs, authorId);
    }

    // resolve action
    if (ticket.status === 2) return true;

    const resolveTime = Number(actionTs) - Number(ticket.messageId);
    const resolveDate = new Date(parseFloat(actionTs) * 1000);
    if (macro.macro === "?resolve") {
      await resolveManagedTicket(
        client,
        ticket.program.channelId,
        ticket.id,
        authorId,
        resolveTime,
        resolveDate,
      );
      return true;
    }

    await resolveWithMacro(
      client,
      ticket.id,
      macro,
      resolveTime,
      resolveDate,
      threadTs,
    );

    return true;
  } catch (e) {
    console.error("Problem handling managed program macro: ", e);
    console.error("Macro: ", macro);
    console.error("Ticket: ", ticket.id);
    return false;
  }
}

export async function postManagedTicketReceived(
  client: WebClient,
  message: GenericMessageEvent | FileShareMessageEvent,
  program: Program,
) {
  const newMessage = message as typeof message & {
    metadata?: { event_type: string };
  };
  if (newMessage.metadata?.event_type === "anchor") {
    console.log(`Skipping possibly anchored message ${message.ts}`);
    return;
  }
  console.log(newMessage);

  const user = await createUser(client, message.user as string);
  const ticket = await prisma.ticket.create({
    data: {
      messageId: message.ts,
      programId: program.id,
      message: (message.text as string) ?? null,
      dateCreated: new Date(parseFloat(message.ts as string) * 1000),
      slackUserId: message.user as string,
    },
    include: { program: true },
  });
  console.log(
    `Indexed ticket from ${new Date(ticket.dateCreated).toLocaleString()}`,
  );
  const hangTime = await getHangTime(
    program.id,
    new Date(new Date().getDate() - 7),
    new Date(),
  );
  try {
    await client.chat.postMessage({
      channel: program.channelId,
      thread_ts: message.ts,
      text: program.createMessage.replace("{USERNAME}", user.username),
      username: program.supportBotName,
      icon_url: program.logo ?? "",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: program.createMessage.replace(
              "{USERNAME}",
              `<@${message.user}>`,
            ),
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Resolve",
                emoji: true,
              },
              value: ticket.id,
              action_id: "resolve",
              style: "primary",
            },
          ],
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Your estimated wait time is ${humanizeDuration(
                hangTime?.median ?? 0,
              )} -  <https://unified.help.hackclub.com/programs/${program.id}/ticket/${ticket.id}|backend> (for support team).`,
            },
          ],
        },
      ],
      unfurl_links: false,
    });
    await indexThread(
      client,
      ticket.programId,
      ticket.program.channelId,
      ticket.messageId,
    );
  } catch (e) {
    console.error("Failed to post managed ticket reply: ", e);
  }
  return;
}
