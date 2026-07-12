import { App } from "@slack/bolt";
import { prisma } from "./lib/prisma";
import { config } from "dotenv";
import { indexThread } from "./tools/indexer";
import type { BacklogJob } from "./lib/types";
import express from "express";
import { backlog, stopBacklog } from "./tools/backlogger";
config();

const app = new App({
  token: process.env["SLACK_BOT_TOKEN"]!,
  socketMode: true,
  appToken: process.env["SLACK_APP_TOKEN"]!,
});

const server = express();
const port = 4000;

const currentState = {
  backlogger: <BacklogJob[]>[],
};
/* claude code, temporary */
process.on("unhandledRejection", (reason) =>
  console.error("🔴 unhandledRejection:", reason),
);
process.on("uncaughtException", (err) =>
  console.error("🔴 uncaughtException:", err),
);

server.use(express.json());

server.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("🔴 Express error:", err);
    if (!res.headersSent) res.status(500).json({ error: String(err) });
  },
);


server.get("/", (_req, res) => {
  return res.json({ online: "true" });
});

server.post("/api/backlog/:id/start", (req, res) => {
  const programId = req.params.id;
  let backlogTo, backlogFrom
  console.log(req.body)
  if (req.body.backlogTo) backlogTo = req.body.backlogTo;
  if (req.body.backlogFrom) backlogFrom = req.body.backlogFrom;
  const actorId = req.body.actorId;

  const possibleIndex = currentState.backlogger.findLastIndex(
    (t) => t.programId === programId && !t.finishDate && !t.error,
  );
  if (possibleIndex !== -1) {
    return res.status(400).json({ status: "pending" });
  }
  console.log(`indexing program ${programId}`);
  startBacklogTask(programId, actorId, backlogTo, backlogFrom);
  return res.json({ status: "created" });
});
server.get("/api/backlog/:id/status", (req, res) => {
  const programId = req.params.id;
  const possibleIndex = currentState.backlogger.findLastIndex(
    (t) => t.programId === programId && !t.error,
  );
  if (possibleIndex === -1) {
    return res.json({ status: "unqueued" });
  }
  if (currentState.backlogger[possibleIndex]?.error) {
    return res.json({ status: "failed", job: currentState.backlogger[possibleIndex] });
  }
  if (currentState.backlogger[possibleIndex]?.finishDate && !currentState.backlogger[possibleIndex]?.error) {
    return res.json({ status: "success", job: currentState.backlogger[possibleIndex] });
  }
  return res.json({ status: "pending", job: currentState.backlogger[possibleIndex] });
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
    );
  } catch (e) {
    if (e instanceof Error) {
      const job = currentState.backlogger[newLength - 1];
      if (job !== undefined) {
        job.error = e.message;
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
  // Start your app
  await app.start();

  app.message(async ({ message }) => {
    if (message.subtype === undefined) {
      const program = await prisma.program.findFirst({
        where: {
          channelId: message.channel,
        },
      });
      if (!program) {
        console.warn("Bot is not enrolled in this channel, skipping");
        return;
      }
      const isReply = message.thread_ts && message.thread_ts !== message.ts;
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
    }
  });

  app.logger.info("⚡️ Bolt app is running!");
})();
