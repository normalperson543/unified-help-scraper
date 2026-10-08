import { App, ExpressReceiver } from "@slack/bolt";
import { prisma } from "./lib/prisma.js";
import { config } from "dotenv";
import {
  addAsHelper,
  indexThread,
  indexUsersFromChannel,
  indexUsersFromUserGroup,
  reindexTicket,
} from "./tools/indexer.js";
import express from "express";
import { backlog, stopBacklog } from "./tools/backlogger.js";
import { currentState } from "./lib/state.js";
import {
  handleManagedProgramMacro,
  postManagedTicketReceived,
  getForwardedTicketUser,
  type MessageMetadata,
  reopenManagedTicket,
  resolveManagedTicket,
  resolveWithMacro,
} from "./lib/managed.js";
import { MANAGED_PROGRAM_MACROS, type ManagedProgramMacro } from "./lib/constants.js";

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
    console.log("PING")
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
server.post("/api/ticket/:id/resolve-managed", (req, res) => {
  const actorId = req.body.actorId;
  const ticketId = req.params.id;
  const messageTs = req.body.messageTs;
  const resolveTime = req.body.resolveTime;
  const resolveDate = new Date(req.body.resolveDate);

  console.log("Resolve command received.")
  console.log(req.body)

  resolveManagedTicket(
    app.client,
    messageTs,
    ticketId,
    actorId,
    resolveTime,
    resolveDate,
  );

  return res.json({ status: "resolved" });
});

server.post("/api/ticket/:id/resolve-with-macro", (req, res) => {
  const ticketId = req.params.id;
  const macro = MANAGED_PROGRAM_MACROS[req.body.macroId] as ManagedProgramMacro;
  const resolveTime = req.body.resolveTime;
  const resolveDate = req.body.resolveDate;
  const threadTs = req.body.threadTs;

  console.log(macro)

  resolveWithMacro(
    app.client,
    ticketId,
    macro,
    resolveTime,
    resolveDate,
    threadTs,
  );

  return res.json({ status: "resolved" });
});

server.post("/api/ticket/:id/reopen-managed", (req, res) => {
  const ticketId = req.params.id;
  const actor = req.body.actor;
  const threadTs = req.body.threadTs;
  console.log(req.body)

  reopenManagedTicket(app.client, ticketId, threadTs, actor);

  return res.json({ status: "reopened" });
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

(async () => {
  app.message(async ({ event, message }) => {
    console.log("PING")
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
      return;
    }
    const forwardedBy = getForwardedTicketUser(
      (message as { metadata?: MessageMetadata }).metadata,
    );
    if (
      message.subtype &&
      message.subtype !== "file_share" &&
      !(message.subtype === "bot_message" && forwardedBy)
    )
      return;

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
        await postManagedTicketReceived(app.client, message, program);
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

  app.event("message_metadata_posted", async ({ event, client }) => {
    if (!getForwardedTicketUser(event.metadata as MessageMetadata)) return;

    const program = await prisma.program.findFirst({
      where: { channelId: event.channel_id },
    });
    if (!program?.managed) return;

    const history = await client.conversations.history({
      channel: event.channel_id,
      latest: event.message_ts,
      inclusive: true,
      limit: 1,
    });
    const forwarded = history.messages?.[0];
    if (!forwarded || forwarded.ts !== event.message_ts) return;
    if (forwarded.thread_ts && forwarded.thread_ts !== forwarded.ts) return;

    await postManagedTicketReceived(
      client,
      {
        ...forwarded,
        channel: event.channel_id,
        metadata: event.metadata,
      } as unknown as Parameters<typeof postManagedTicketReceived>[1],
      program,
    );
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
      const resolveTime = Number(actionTs) - Number(ticket.messageId);
      const resolveDate = new Date(parseFloat(actionTs) * 1000);
      await resolveManagedTicket(
        client,
        messageTs,
        ticketId,
        resolverId,
        resolveTime,
        resolveDate,
      );
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

      await reopenManagedTicket(client, ticketId, messageTs, userId);
    } catch (e) {
      console.error("Problem reopening managed ticket: ", e);
      console.error("Occurred on ticket ", ticketId);
    }
  });

  app.logger.info("⚡️ Bolt app is running!");
})();
