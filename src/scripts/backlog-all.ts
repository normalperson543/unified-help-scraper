// this is a maintenance script
// made with ai :pf:

import "dotenv/config";
import { WebClient } from "@slack/web-api";
import { prisma } from "../lib/prisma.js";
import { currentState } from "../lib/state.js";
import { backlog } from "../tools/backlogger.js";

const ACTOR = "cli";

function usage() {
  console.error("Usage: tsx src/scripts/backlog-all.ts <hours>");
  console.error("  hours: how far back to backlog (positive number). e.g. 24");
}

function bar(done: number, total: number, width = 24): string {
  const ratio = total > 0 ? done / total : 0;
  const filled = Math.round(ratio * width);
  return "[" + "=".repeat(filled) + "-".repeat(Math.max(0, width - filled)) + "]";
}

async function main() {
  const hoursArg = process.argv[2];
  if (!hoursArg) {
    usage();
    process.exit(1);
  }
  const hours = Number(hoursArg);
  if (!Number.isFinite(hours) || hours <= 0) {
    console.error("Error: <hours> must be a positive number.");
    process.exit(1);
  }

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error("Error: SLACK_BOT_TOKEN is not set.");
    process.exit(1);
  }

  const client = new WebClient(token);

  const now = Date.now();
  const oldest = String(now - hours * 60 * 60 * 1000);
  const latest = String(now);

  const programs = await prisma.program.findMany();
  if (programs.length === 0) {
    console.log("No programs found.");
    await prisma.$disconnect();
    return;
  }

  console.log(
    `Backlogging last ${hours} hour(s) for ${programs.length} program(s).`,
  );
  console.log(
    `Range: ${new Date(Number(oldest)).toLocaleString()} -> ${new Date(Number(latest)).toLocaleString()}`,
  );
  console.log();

  let success = 0;
  let failed = 0;
  const failures: { program: string; error: string }[] = [];

  for (let i = 0; i < programs.length; i++) {
    const program = programs[i]!;
    const index =
      currentState.backlogger.push({
        programId: program.id,
        actorId: ACTOR,
        startDate: new Date(),
        backlogTo: new Date(Number(oldest)),
        backlogFrom: new Date(Number(latest)),
        ts: { start: latest, current: latest, end: oldest },
      }) - 1;

    console.log(
      `${bar(i, programs.length)} ${i + 1}/${programs.length} - starting: ${program.name} (${program.id})`,
    );

    try {
      await backlog(client, program, oldest, latest, index);
      success++;
      console.log(
        `${bar(i + 1, programs.length)} ${i + 1}/${programs.length} - done: ${program.name}\n`,
      );
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({ program: program.name, error: msg });
      console.error(
        `${bar(i + 1, programs.length)} ${i + 1}/${programs.length} - FAILED: ${program.name}: ${msg}\n`,
      );
    } finally {
      const job = currentState.backlogger[index];
      if (job) job.finishDate = new Date();
    }
  }

  console.log(`${bar(programs.length, programs.length)} Complete.`);
  console.log(
    `Success: ${success}  Failed: ${failed}  Total: ${programs.length}`,
  );
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) {
      console.log(`  - ${f.program}: ${f.error}`);
    }
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
