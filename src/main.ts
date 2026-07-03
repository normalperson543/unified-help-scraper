import { App } from "@slack/bolt";
import { prisma } from "./lib/prisma";
import { config } from "dotenv";
import { indexThread } from "./tools/indexer";
import { getResolver } from "./lib/tools";
import type { BacklogJob } from "./lib/types";
import express from "express";
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
  older: string,
  newer: string,
) {

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
  console.log(`indexing program ${programId}`);
  startBacklogTask(programId, backlogTo, backlogFrom)
  res.json({"status": "started"})
});
