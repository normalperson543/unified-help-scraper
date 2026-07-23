import type { WebClient } from "@slack/web-api";
import type { Program } from "../generated/prisma/client";
import { indexThread } from "./indexer";
import type { StopJob } from "../lib/types";
import { currentState } from "../main";

const stopQueue: StopJob[] = []; // extremely jank! but do i care? NO!

// TODO: stop queue should be cleared per program when backlog starts
export async function backlog(
  client: WebClient,
  program: Program,
  oldest: string,
  latest: string,
  index: number,
) {
  const sOldest = Math.floor(Number(oldest) / 1000);
  const sLatest = Math.floor(Number(latest) / 1000);
  console.log(oldest, latest, sOldest, sLatest);
  const history = await client.conversations.history({
    channel: program.channelId,
    oldest: String(sOldest),
    latest: String(sLatest),
    limit: 999,
  });
  if (!history.messages) return;
  for (let i = 0; i < history.messages.length; i++) {
    console.log(`Indexing ${history.messages[i]?.ts}`);
    await indexThread(
      client,
      program.id,
      program.channelId,
      history.messages[i]?.ts ?? "",
    );
    const possibleIndex = stopQueue.findIndex(
      (t) => t.programId === program.id,
    );
    if (possibleIndex !== -1) {
      const selectedJob = stopQueue[possibleIndex];
      if (!selectedJob) return;
      stopQueue.splice(possibleIndex);
      console.log("stopping");
      throw new Error(
        `Stopped manually by ${selectedJob.actorId} on ${new Date(selectedJob.stopDate).toLocaleString()}`,
      );
    }
    if (currentState.backlogger[index]) {
      currentState.backlogger[index].ts.current = history.messages[i]?.ts ?? "";
    }
  }
  console.log("Complete.");
}

export async function stopBacklog(programId: string, actorId: string) {
  stopQueue.push({
    programId: programId,
    actorId: actorId,
    stopDate: new Date(),
  });
}
