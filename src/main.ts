import { App } from "@slack/bolt";
import { prisma } from "./lib/prisma";
import { config } from "dotenv";
import { indexThread } from "./tools/indexer";
import { getResolver } from "./lib/tools";
import type { BacklogJob } from "./lib/types";
import express from "express";
import backlog from "./tools/backlogger";
config();

const app = new App({
  token: process.env["SLACK_BOT_TOKEN"]!,
  socketMode: true,
  appToken: process.env["SLACK_APP_TOKEN"]!,
});

const server = express();
const port = 3000;

const currentState = {
  backlogger: <BacklogJob[]>[],
};

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
    backlog(
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

server.post("/api/backlog/:id/start", (req, res) => {
  const programId = req.params.id;
  const backlogTo = req.body.backlogTo;
  const backlogFrom = req.body.backlogFrom;
  const actorId = req.body.actorId;

  const possibleIndex = currentState.backlogger.findIndex(
    (t) => t.programId === programId && t.finishDate,
  );
  if (possibleIndex !== -1) {
    res.status(400).json({ status: "pending" });
  }
  console.log(`indexing program ${programId}`);
  startBacklogTask(programId, actorId, backlogTo, backlogFrom);
  res.json({ status: "created" });
});
server.get("/api/backlog/:id/status", (req, res) => {
  res.json()
});
