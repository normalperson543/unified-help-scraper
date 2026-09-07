// This script was AI coded as this is a maintenance script

import "dotenv/config";
import { WebClient } from "@slack/web-api";
import { prisma } from "../lib/prisma.js";

function usage() {
  console.error("Usage: tsx src/scripts/remove-recent-reactions.ts <hours> [--dry-run] [--resume-after <ticket-id>]");
  console.error("  hours:              how far back to look (positive number). e.g. 24");
  console.error("  --dry-run:          list the reactions that would be removed without removing them");
  console.error("  --resume-after:     skip tickets up to and including this ticket id, then continue");
}

function bar(done: number, total: number, width = 24): string {
  const ratio = total > 0 ? done / total : 0;
  const filled = Math.round(ratio * width);
  return "[" + "=".repeat(filled) + "-".repeat(Math.max(0, width - filled)) + "]";
}

function createRateLimiter(callsPerMinute: number) {
  const minIntervalMs = 60000 / callsPerMinute;
  let lastCallTime = 0;

  return async function rateLimit<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const elapsed = now - lastCallTime;
    if (elapsed < minIntervalMs) {
      await new Promise((resolve) => setTimeout(resolve, minIntervalMs - elapsed));
    }
    lastCallTime = Date.now();
    return fn();
  };
}

async function main() {
  const args = process.argv.slice(2);
  const hoursArg = args.find((a) => !a.startsWith("-"));
  const dryRun = args.includes("--dry-run");

  const resumeAfterIndex = args.indexOf("--resume-after");
  const resumeAfterTicketId =
    resumeAfterIndex !== -1 ? args[resumeAfterIndex + 1] : undefined;
  if (resumeAfterIndex !== -1 && !resumeAfterTicketId) {
    console.error("Error: --resume-after requires a ticket id.");
    usage();
    process.exit(1);
  }

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
  const rateLimit = createRateLimiter(20);
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

  console.log(
    `${dryRun ? "[DRY RUN] " : ""}Removing reactions from program tickets created in the last ${hours} hour(s).`,
  );
  console.log(`Cutoff: ${cutoff.toLocaleString()}`);
  console.log();

  const tickets = await prisma.ticket.findMany({
    where: {
      dateCreated: {
        gte: cutoff,
      },
    },
    include: {
      program: true,
    },
    orderBy: {
      dateCreated: "desc",
    },
  });

  if (tickets.length === 0) {
    console.log("No tickets found in that time range.");
    await prisma.$disconnect();
    return;
  }

  console.log(`Found ${tickets.length} ticket(s).`);

  let skippedTickets = 0;
  if (resumeAfterTicketId) {
    const resumeIndex = tickets.findIndex((t) => t.id === resumeAfterTicketId);
    if (resumeIndex === -1) {
      console.error(
        `Error: ticket ${resumeAfterTicketId} was not found in the last ${hours} hour(s). It may be outside the time range or the id may be wrong.`,
      );
      await prisma.$disconnect();
      process.exit(1);
    }
    skippedTickets = resumeIndex + 1;
    tickets.splice(0, skippedTickets);
    console.log(
      `Resuming after ticket ${resumeAfterTicketId}; skipping ${skippedTickets} already-processed ticket(s).`,
    );
  }

  if (tickets.length === 0) {
    console.log("No remaining tickets to process.");
    await prisma.$disconnect();
    return;
  }

  console.log(`Processing ${tickets.length} remaining ticket(s).`);
  console.log();

  let removed = 0;
  let skipped = 0;
  let failed = 0;
  const failures: { ticket: string; emoji: string; error: string }[] = [];

  for (let i = 0; i < tickets.length; i++) {
    const ticket = tickets[i]!;
    console.log(
      `${bar(i, tickets.length)} ${i + 1}/${tickets.length} - ticket ${ticket.id} (${ticket.program.name})`,
    );

    try {
      const reactionsRes = await rateLimit(() =>
        client.reactions.get({
          channel: ticket.program.channelId,
          timestamp: ticket.messageId,
          full: true,
        }),
      );

      const reactions = reactionsRes.message?.reactions ?? [];
      if (reactions.length === 0) {
        console.log("  no reactions to remove");
        skipped++;
        continue;
      }

      for (const reaction of reactions) {
        const emoji = reaction.name;
        if (!emoji) continue;

        if (dryRun) {
          console.log(`  would remove :${emoji}: (${reaction.count ?? 0} reaction(s))`);
          removed++;
          continue;
        }

        try {
          await rateLimit(() =>
            client.reactions.remove({
              channel: ticket.program.channelId,
              timestamp: ticket.messageId,
              name: emoji,
            }),
          );
          console.log(`  removed :${emoji}:`);
          removed++;
        } catch (e) {
          failed++;
          const msg = e instanceof Error ? e.message : String(e);
          failures.push({ ticket: ticket.id, emoji, error: msg });
          console.warn(`  could not remove :${emoji}:: ${msg}`);
        }
      }
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({ ticket: ticket.id, emoji: "(fetch)", error: msg });
      console.error(`  failed to fetch reactions: ${msg}`);
    }
  }

  console.log();
  console.log(`${bar(tickets.length, tickets.length)} Complete.`);
  console.log(`Tickets checked: ${tickets.length}`);
  console.log(`Reactions removed: ${removed}`);
  console.log(`Reactions skipped/failed: ${skipped + failed}`);

  if (failures.length > 0) {
    console.log("\nFailures (bot tokens can only remove bot-added reactions):");
    for (const f of failures) {
      console.log(`  - ticket ${f.ticket}, emoji :${f.emoji}: ${f.error}`);
    }
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
