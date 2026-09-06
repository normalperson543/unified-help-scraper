import { App, ExpressReceiver } from "@slack/bolt";
import { prisma } from "./lib/prisma.js";
import { config } from "dotenv";
import {
  addAsHelper,
  createUser,
  indexThread,
  indexUsersFromChannel,
  indexUsersFromUserGroup,
  reindexTicket,
  type TicketWithAssignees,
} from "./tools/indexer.js";
import express from "express";
import { backlog, stopBacklog } from "./tools/backlogger.js";
import { currentState } from "./lib/state.js";
import { getHangTime } from "./lib/tools.js";
import { syncTicketReaction } from "./lib/slack.js";
import { getManagedProgramMacro } from "./lib/constants.js";

export { currentState };

config();

const receiver = new ExpressReceiver({
  signingSecret: process.env["SLACK_SIGNING_SECRET"]!,
  endpoints: "/events",
});

const app = new App({
  token: process.env["SLACK_BOT_TOKEN"]!,
  receiver,
});

const server = express();
const port = 4000;

/* claude code, temporary */
process.on("unhandledRejection", (reason) =>
  console.error("🔴 unhandledRejection:", reason),
);
process.on("uncaughtException", (err) =>
  console.error("🔴 uncaughtException:", err),
);

// this was AI
server.use(
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.path === "/" || req.path.startsWith("/api")) {
      return express.json()(req, res, next);
    }
    next();
  },
);

server.use("/slack", receiver.router);

server.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("🔴 Express error:", err);
    if (!res.headersSent) res.status(500).json({ error: String(err) });
  },
);

server.use(
  "/api",
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const apiKey = req.header("x-api-key"); // This middleware was made with Claude, I had to make it work with my current setup

    if (!apiKey) {
      return res.status(401).json({ error: "API key is missing" });
    }

    if (apiKey !== process.env.SCRAPER_API_KEY) {
      return res.status(403).json({ error: "Invalid API key" });
    }
    next();
  },
);

server.get("/", (_req, res) => {
  return res.json({ online: "true" });
});

server.get("/api", (_req, res) => {
  return res.json({ online: "true" });
});

server.post("/api/backlog/:id/start", (req, res) => {
  const programId = req.params.id;
  let backlogTo, backlogFrom;
  if (req.body.backlogTo) backlogTo = req.body.backlogTo;
  if (req.body.backlogFrom) backlogFrom = req.body.backlogFrom;
  const actorId = req.body.actorId;

  const possibleIndex = currentState.backlogger.findLastIndex(
    (t) => t.programId === programId && !t.finishDate && !t.error,
  );
  if (possibleIndex !== -1) {
    return res.status(400).json({ status: "pending" });
  }
  console.log(`Starting indexing of program ${programId}.`);
  startBacklogTask(programId, actorId, backlogTo, backlogFrom);
  return res.json({ status: "created" });
});
server.post("/api/index-user-group/:id", (req, res) => {
  const programId = req.params.id;
  const usergroupId = req.body.usergroupId;

  indexUsersFromUserGroup(usergroupId, programId, app.client);
  return res.json({ status: "created" });
});
server.post("/api/index-channel/:id", (req, res) => {
  const programId = req.params.id;
  const channelId = req.body.channelId;

  indexUsersFromChannel(channelId, programId, app.client);
  return res.json({ status: "created" });
});
server.post("/api/reindex-ticket/:id", async (req, res) => {
  const ticketId = req.params.id;
  const actorId = req.body.actorId;
  try {
    await reindexTicket(app.client, ticketId, actorId);
    return res.json({ status: "success" });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`Reindex of ticket ${ticketId} failed: ${error}`);
    return res.status(500).json({ status: "failed", error: error });
  }
});
server.post("/api/index-thread/:id", async (req, res) => {
  const ticketId = req.params.id;
  try {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { program: true },
    });
    if (!ticket) throw new Error("TICKET_NOT_FOUND");
    await indexThread(
      app.client,
      ticket.programId,
      ticket.program.channelId,
      ticket.messageId,
    );
    return res.json({ status: "success" });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`Index thread for ticket ${ticketId} failed: ${error}`);
    return res.status(500).json({ status: "failed", error: error });
  }
});
server.get("/api/backlog/:id/status", (req, res) => {
  const programId = req.params.id;
  const possibleIndex = currentState.backlogger.findLastIndex(
    (t) => t.programId === programId,
  );
  if (possibleIndex === -1) {
    return res.json({ status: "unqueued" });
  }
  if (currentState.backlogger[possibleIndex]?.error) {
    return res.json({
      status: "failed",
      job: currentState.backlogger[possibleIndex],
    });
  }
  if (
    currentState.backlogger[possibleIndex]?.finishDate &&
    !currentState.backlogger[possibleIndex]?.error
  ) {
    return res.json({
      status: "success",
      job: currentState.backlogger[possibleIndex],
    });
  }
  return res.json({
    status: "pending",
    job: currentState.backlogger[possibleIndex],
  });
});
server.get("/api/backlog", (req, res) => {
  return res.json(currentState.backlogger);
});
server.post("/api/backlog/:id/stop", (req, res) => {
  const programId = req.params.id;
  const actorId = req.body.actorId;
  stopBacklog(programId, actorId);

  return res.json({ status: "stopped" });
});

server.listen(port, () => console.log("API ready"));

async function startBacklogTask(
  programId: string,
  actorId: string,
  backlogTo?: string,
  backlogFrom?: string,
) {
  const newLength = currentState.backlogger.push({
    programId: programId,
    actorId: actorId,
    startDate: new Date(),
    backlogTo: new Date(backlogTo ?? 0),
    backlogFrom: new Date(backlogFrom ?? 1999999999999999),
    ts: {
      start: backlogFrom!,
      current: backlogFrom!,
      end: backlogTo!,
    },
  });
  try {
    const program = await prisma.program.findUnique({
      where: {
        id: programId,
      },
    });
    if (!program) throw new Error("no program found");
    await backlog(
      app.client,
      program,
      backlogTo ?? "0",
      backlogFrom ?? "1999999999999999",
      newLength - 1,
    );
  } catch (e) {
    if (e instanceof Error) {
      const job = currentState.backlogger[newLength - 1];
      if (job !== undefined) {
        job.error = e.message;
        console.error(e);
      }
    }
  } finally {
    const job = currentState.backlogger[newLength - 1];
    if (job !== undefined) {
      job.finishDate = new Date();
    }
  }
}

async function handleManagedProgramMacro(
  client: typeof app.client,
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
  const username = ticket.program.supportBotName;
  const iconUrl = ticket.program.logo ?? "";

  try {
    if (macro.action === "reopen") {
      if (ticket.status !== 2) return true;
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
        username,
        icon_url: iconUrl,
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
                text: `Your estimated wait time is ${
                  hangTime?.median
                    ? Math.round((hangTime.median / 60) * 100) / 100
                    : 0
                } minutes -  <https://unified.help.hackclub.com/programs/${ticket.programId}/ticket/${updatedTicket.id}|Open with Unified Help>`,
              },
            ],
          },
        ],
        unfurl_links: false,
      });
      return true;
    }

    // resolve action
    if (ticket.status === 2) return true;

    if (macro.macro === "?resolve") {
      const updatedTicket = (await prisma.ticket.update({
        where: { id: ticket.id },
        data: {
          status: 2,
          resolverId: authorId,
          resolveTime: Number(actionTs) - Number(ticket.messageId),
          resolveDate: new Date(parseFloat(actionTs) * 1000),
        },
        include: { assignees: true },
      })) as TicketWithAssignees;

      await syncTicketReaction(
        client,
        ticket.program.channelId,
        ticket.messageId,
        updatedTicket.status,
      );

      await client.chat.postMessage({
        channel: ticket.program.channelId,
        thread_ts: threadTs,
        username,
        icon_url: iconUrl,
        text: `<@${authorId}> marked this as resolved.`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: ticket.program.resolveMessage.replace(
                "{USERNAME}",
                `<@${authorId}>`,
              ),
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `<@${authorId}> marked this as resolved. If this issue is still unresolved, click the *Reopen* button.`,
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Reopen", emoji: true },
                value: updatedTicket.id,
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
                text: `<https://unified.help.hackclub.com/programs/${ticket.programId}/ticket/${updatedTicket.id}|Open with Unified Help>`,
              },
            ],
          },
        ],
        unfurl_links: false,
      });
      return true;
    }

    // Custom resolve macro — post the macro message and resolve, but do not
    // assign the helper and do not post the normal resolve block.
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
        resolveTime: Number(actionTs) - Number(ticket.messageId),
        resolveDate: new Date(parseFloat(actionTs) * 1000),
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
      username,
      icon_url: iconUrl,
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
              text: `<https://unified.help.hackclub.com/programs/${ticket.programId}/ticket/${ticket.id}|Open with Unified Help>`,
            },
          ],
        },
      ],
      unfurl_links: false,
    });
    return true;
  } catch (e) {
    console.error("Problem handling managed program macro: ", e);
    console.error("Macro: ", macro);
    console.error("Ticket: ", ticket.id);
    return false;
  }
}

(async () => {
  app.message(async ({ event, message }) => {
    if (event.subtype === "message_deleted") {
      const deletedTs = event.deleted_ts;

      const ticket = await prisma.ticket.findFirst({
        where: {
          messageId: deletedTs,
        },
      });
      if (!ticket) return;
      console.log("Deleting ticket: ", ticket);
      await prisma.reply.deleteMany({
        where: {
          ticketId: ticket.id,
        },
      });
      await prisma.iNote.deleteMany({
        where: {
          ticketId: ticket.id,
        },
      });
      await prisma.ticket.delete({
        where: {
          id: ticket.id,
        },
      });
    }
    if (message.subtype) return;

    const program = await prisma.program.findFirst({
      where: {
        channelId: message.channel,
      },
    });

    if (!program) {
      console.warn("Bot is not enrolled in this channel, skipping");
      return;
    }

    if (!message.thread_ts) {
      // new ticket
      if (program.managed) {
        const newMessage = message as typeof message & {
          metadata?: { event_type: string };
        };
        if (newMessage.metadata?.event_type === "anchor") {
          console.log(`Skipping possibly anchored message ${message.ts}`);
          return;
        }
        console.log(newMessage);

        const user = await createUser(app.client, message.user as string);
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
          await app.client.chat.postMessage({
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
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "Once you've received a solution, click the *Resolve* button to close the ticket.",
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
                    text: `Your estimated wait time is ${
                      hangTime?.median
                        ? Math.round((hangTime.median / 60) * 100) / 100
                        : 0
                    } minutes -  <https://unified.help.hackclub.com/programs/${program.id}/ticket/${ticket.id}|Open with Unified Help>`,
                  },
                ],
              },
            ],
            unfurl_links: false,
          });
          await indexThread(
            app.client,
            ticket.programId,
            ticket.program.channelId,
            ticket.messageId,
          );
        } catch (e) {
          console.error("Failed to post managed ticket reply: ", e);
        }
        return;
      }
    }
    const isReply = message.thread_ts && message.thread_ts !== message.ts;
    if (isReply && program.managed) {
      await handleManagedProgramMacro(app.client, program, message);
    }
    if (isReply) {
      try {
        indexThread(
          app.client,
          program.id,
          message.channel,
          message.thread_ts!,
        );
      } catch (e) {
        console.warn(e);
      }
    } else {
      try {
        indexThread(app.client, program.id, message.channel, message.ts!);
      } catch (e) {
        console.warn(e);
      }
    }
  });

  app.event("subteam_members_changed", async ({ event, client }) => {
    const { subteam_id, added_users } = event;
    if (added_users) {
      const program = await prisma.program.findFirst({
        where: {
          userGroup: subteam_id,
        },
      });
      if (!program || program === null) {
        console.warn(
          "Tried to find program with subteam ID ",
          subteam_id,
          " but no program was found, ignoring",
        );
        return;
      }
      console.log("Adding users ", added_users, " to ", program?.id);
      for (let i = 0; i < added_users.length; i++) {
        try {
          await addAsHelper(added_users[i]!, program!.id, client);
        } catch (e) {
          console.error(e);
        }
      }
    }
  });

  app.event("member_joined_channel", async ({ event, client }) => {
    const { user, channel } = event;
    if (user && channel) {
      const program = await prisma.program.findFirst({
        where: {
          helperChannelId: channel,
        },
      });
      if (!program || program === null) {
        console.warn(
          "Tried to find program with helper channel ID ",
          channel,
          " but no program was found, ignoring",
        );
        return;
      }
      console.log("Adding user ", user, " to ", program?.id);
      try {
        await addAsHelper(user, program!.id, client);
      } catch (e) {
        console.error(e);
      }
    }
  });
  app.action("resolve", async ({ ack, body, client }) => {
    await ack();
    if (body.type !== "block_actions" || !body.actions[0]) return;
    const action = body.actions[0];
    if (action.type !== "button") return;
    const ticketId = action.value;
    const resolverId = body.user.id;
    const channelId = body.channel?.id;
    const messageTs = body.message?.ts;
    const actionTs = action.action_ts;
    if (!ticketId || !resolverId || !channelId || !messageTs || !actionTs)
      return;
    try {
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        include: { program: true, assignees: true },
      });
      if (!ticket) throw new Error("Ticket not found");
      await createUser(client, resolverId);
      const resolverUser = await prisma.slackUser.findUnique({
        where: {
          id: resolverId,
        },
        include: {
          programs: true,
        },
      });
      if (
        !resolverUser?.programs.some((p) => p.id === ticket.program.id) &&
        resolverId !== ticket.slackUserId
      ) {
        await app.client.chat.postEphemeral({
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
        await app.client.chat.postEphemeral({
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
          resolveTime: Number(actionTs) - Number(ticket.messageId),
          resolveDate: new Date(parseFloat(actionTs) * 1000),
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
          channel: channelId,
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
              type: "section",
              text: {
                type: "mrkdwn",
                text: `<@${resolverId}> marked this as resolved. If this issue is still unresolved, click the *Reopen* button.`,
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
                  value: updatedTicket.id,
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
                  text: `<https://unified.help.hackclub.com/programs/${ticket.programId}/ticket/${updatedTicket.id}|Open with Unified Help>`,
                },
              ],
            },
          ],
          unfurl_links: false,
        });
        await indexThread(
          // run a reindex
          app.client,
          ticket.program.id,
          ticket.program.channelId,
          ticket.messageId,
        );
      } catch (e) {
        console.error("Failed to post resolve reply: ", e);
      }
    } catch (e) {
      console.error("Problem resolving managed ticket: ", e);
      console.error("Occurred on ticket ", ticketId);
    }
  });

  app.action("reopen", async ({ ack, body, client }) => {
    await ack();
    if (body.type !== "block_actions" || !body.actions[0]) return;
    const action = body.actions[0];
    if (action.type !== "button") return;
    const ticketId = action.value;
    const userId = body.user.id;
    const channelId = body.channel?.id;
    const messageTs = body.message?.ts;
    if (!ticketId || !userId || !channelId || !messageTs) return;

    try {
      const ticket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        include: { program: true, assignees: true },
      });
      if (!ticket) throw new Error("Ticket not found");
      await createUser(client, userId);
      const reopenerUser = await prisma.slackUser.findUnique({
        where: {
          id: userId,
        },
        include: {
          programs: true,
        },
      });
      if (
        !reopenerUser?.programs.some((p) => p.id === ticket.program.id) &&
        userId !== ticket.slackUserId
      ) {
        await app.client.chat.postEphemeral({
          channel: ticket.program.channelId,
          user: userId,
          thread_ts: ticket.messageId,
          username: ticket.program.supportBotName,
          icon_url: ticket.program.logo ?? "",
          text: ":neocat_confused: Sorry, you can't reopen this ticket as it's not yours.",
        });
        return;
      }
      if (ticket.status !== 2) {
        await app.client.chat.postEphemeral({
          channel: ticket.program.channelId,
          user: userId,
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

      try {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: messageTs,
          username: ticket.program.supportBotName,
          icon_url: ticket.program.logo ?? "",
          text: `This ticket was reopened by <@${userId}>.`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `This ticket was reopened by <@${userId}>. To close it, click Resolve.`,
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
                  text: `Your estimated wait time is ${
                    hangTime?.median
                      ? Math.round((hangTime.median / 60) * 100) / 100
                      : 0
                  } minutes -  <https://unified.help.hackclub.com/programs/${ticket.programId}/ticket/${updatedTicket.id}|Open with Unified Help>`,
                },
              ],
            },
          ],
          unfurl_links: false,
        });
        await indexThread(
          // run a reindex
          app.client,
          ticket.program.id,
          ticket.program.channelId,
          ticket.messageId,
        );
      } catch (e) {
        console.error("Failed to post reopen reply: ", e);
      }
    } catch (e) {
      console.error("Problem reopening managed ticket: ", e);
      console.error("Occurred on ticket ", ticketId);
    }
  });

  app.logger.info("⚡️ Bolt app is running!");
})();
