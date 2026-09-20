import { getSlackUser } from "./data.js";
import { prisma } from "./prisma.js";

export async function getResolver(str: string) {
  const unescaped = str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  if (unescaped.indexOf("<@") === -1) {
    return;
  }
  const firstPart = unescaped.substring(unescaped.indexOf("<@") + 2);
  const userId = firstPart.substring(0, firstPart.indexOf(">"));
  return await getSlackUser(userId);
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid] ?? 0;
}

export function humanizeDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return "0 seconds";

  const total = Math.round(totalSeconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
    if (minutes > 0) {
      parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
    }
  } else if (minutes > 0) {
    parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
    if (seconds > 0) {
      parts.push(`${seconds} second${seconds === 1 ? "" : "s"}`);
    }
  } else {
    parts.push(`${seconds} second${seconds === 1 ? "" : "s"}`);
  }

  return parts.join(" ");
}

export async function getHangTime(
  programId: string,
  oldest: Date,
  newest: Date,
) {
  const tickets = await prisma.ticket.findMany({
    where: {
      programId: programId,
      responseTime: {
        not: 0,
      },
      dateCreated: {
        gte: oldest,
        lte: newest,
      },
    },
    select: {
      responseTime: true,
    },
  });
  const times = tickets.map((t) => t.responseTime);
  return {
    median: median(times),
    average: average(times),
  };
}