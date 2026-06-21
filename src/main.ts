import { App } from "@slack/bolt";
import { prisma } from "./lib/prisma";
import { config } from "dotenv";

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
            console.warn(
              "A reply was created with no corresponding ticket, ignoring",
            );
            return;
          }
          await prisma.reply.create({
            data: {
              ticketId: ticket.id,
              programId: "80700706-e07c-4b36-aadf-a1bc345834ad",
              message: message.text ?? "",
              dateCreated: new Date(parseFloat(message.ts) * 1000),
              slackUserId: message.user,
            },
          });
        } catch (e) {
          console.warn(e);
        }
      }
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
            programId: "80700706-e07c-4b36-aadf-a1bc345834ad",
            message: message.text ?? "",
            dateCreated: new Date(parseFloat(message.ts) * 1000),
            slackUserId: message.user,
          },
        });
      } catch (e) {
        console.warn(e);
      }
    }
  });

  app.logger.info("⚡️ Bolt app is running!");
})();
