import type { WebClient } from "@slack/web-api";
import type { Program } from "../../generated/prisma/client";
import { indexThread } from "./indexer";
import type { StopJob } from "../lib/types";

const stopQueue: StopJob[] = []; // extremely jank! but do i care? NO!

export async function backlog(
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
    const possibleIndex = stopQueue.findIndex(
      (t) => t.programId === program.id,
    );
    if (possibleIndex !== -1) {
      const selectedJob = stopQueue[possibleIndex];
      if (!selectedJob) return;
      stopQueue.splice(possibleIndex);
      throw new Error(
        `Stopped manually by ${selectedJob.actorId} on ${new Date(selectedJob.stopDate).toLocaleString()}`,
      );
    }
  }
}

export async function stopBacklog(programId: string, actorId: string) {
  stopQueue.push({
    programId: programId,
    actorId: actorId,
    stopDate: new Date(),
  });
}
