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