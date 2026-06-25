import type { WebClient } from "@slack/web-api";
import { prisma } from "../lib/prisma";

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

  let ticket = await prisma.ticket.findFirst({
    where: {
      messageId: threadTs as string,
    },
  });
  console.log(thread.messages[0]);
  if (!ticket) {
    const user = await prisma.slackUser.findUnique({
      where: {
        id: thread.messages[0]?.user as string,
      },
    });
    if (!user) {
      const slackUser = await client.users.info({
        user: thread.messages[0]?.user as string,
      });
      await prisma.slackUser.create({
        data: {
          id: thread.messages[0]?.user as string,
          username:
            slackUser.user?.real_name ?? slackUser.user?.name ?? "Unknown user",
        },
      });
    }
    ticket = await prisma.ticket.create({
      data: {
        messageId: threadTs,
        programId: program,
        message: (thread.messages[0]?.text as string) ?? "",
        dateCreated: new Date(
          parseFloat(thread.messages[0]?.ts as string) * 1000,
        ),
        slackUserId: thread.messages[0]?.user as string,
      },
    });
    console.log(
      `Indexed ticket from ${new Date(ticket.dateCreated).toLocaleString()}`,
    );
  }

  for (let i = 0; i < thread.messages.length; i++) {
    const user = await prisma.slackUser.findUnique({
      where: {
        id: thread.messages[i]?.user as string,
      },
    });
    if (!user) {
      const slackUser = await client.users.info({
        user: thread.messages[i]?.user as string,
      });
      await prisma.slackUser.create({
        data: {
          id: thread.messages[i]?.user as string,
          username:
            slackUser.user?.real_name ?? slackUser.user?.name ?? "Unknown user",
        },
      });
    }
    if (i > 0) {
      const count = await prisma.reply.count({
        where: {
          messageId: thread.messages[i]?.ts as string,
        },
      });
      if (count === 0) {
        const r = await prisma.reply.create({
          data: {
            ticketId: ticket.id,
            messageId: thread.messages[i]?.ts as string,
            message: (thread.messages[i]?.text as string) ?? "",
            dateCreated: new Date(
              parseFloat(thread.messages[i]?.ts as string) * 1000,
            ),
            slackUserId: thread.messages[i]?.user as string,
          },
        });
        console.log(
          `Indexed reply from ${new Date(r.dateCreated).toLocaleString()}`,
        );
      }
    }
  }
}
