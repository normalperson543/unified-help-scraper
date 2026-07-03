import type { WebClient } from "@slack/web-api";
import type { Program } from "../../generated/prisma/client";
import { indexThread } from "./indexer";

export default async function backlog(
  client: WebClient,
  program: Program,
  oldest: string,
  latest: string,
) {
  const history = await client.conversations.history({
    channel: program.channelId,
    oldest: oldest,
    latest: latest,
    limit: 999,
  });
  if (!history.messages) return;
  for (let i = 0; i < history.messages.length; i++) {
    console.log(`Indexing ${history.messages[i]?.ts}`);
    await indexThread(
      client,
      program.id,
      program.channelId,
      history.messages[i]?.ts!,
    );
  }
}
