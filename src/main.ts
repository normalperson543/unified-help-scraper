import { App } from "@slack/bolt";
import { prisma } from "./lib/prisma";
import { config } from "dotenv";
import { indexThread } from "./tools/indexer";

config();

const app = new App({
  token: process.env["SLACK_BOT_TOKEN"]!,
  socketMode: true,
  appToken: process.env["SLACK_APP_TOKEN"]!,
});

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
          console.log("hello");
          const user = await prisma.slackUser.findUnique({
            where: {
              id: message.user,
            },
          });
          if (!user) {
            const slackUser = await app.client.users.info({
              user: message.user,
            });
            await prisma.slackUser.create({
              data: {
                id: message.user,
                username:
                  slackUser.user?.real_name ??
                  slackUser.user?.name ??
                  "Unknown user",
              },
            });
          }
          const ticket = await prisma.ticket.findFirst({
            where: {
              messageId: message.thread_ts!,
            },
          });
          if (!ticket) {
            indexThread(
              app.client,
              program.id,
              program.channelId,
              message.thread_ts!,
            );
            return;
          }
          await prisma.reply.create({
            data: {
              ticketId: ticket.id,
              message: message.text ?? "",
              dateCreated: new Date(parseFloat(message.ts) * 1000),
              slackUserId: message.user,
              messageId: message.ts
            },
          });
        } catch (e) {
          console.warn(e);
        }
      } else {
        // index the ticket
        try {
          console.log("hello");
          const user = await prisma.slackUser.findUnique({
            where: {
              id: message.user,
            },
          });
          if (!user) {
            const slackUser = await app.client.users.info({
              user: message.user,
            });
            await prisma.slackUser.create({
              data: {
                id: message.user,
                username:
                  slackUser.user?.real_name ??
                  slackUser.user?.name ??
                  "Unknown user",
              },
            });
          }
          await prisma.ticket.create({
            data: {
              messageId: message.ts,
              programId: program.id,
              message: message.text ?? "",
              dateCreated: new Date(parseFloat(message.ts) * 1000),
              slackUserId: message.user,
            },
          });
        } catch (e) {
          console.warn(e);
        }
      }
    }
  });

  app.logger.info("⚡️ Bolt app is running!");
})();
