import { getSlackUser } from "./data.js";

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
