import { getSlackUser } from "./data.js";

export async function getResolver(str: string) {
  if (str.indexOf("<@") === -1) {
    return;
  }
  const firstPart = str.substring(str.indexOf("<@") + 2);
  const userId = firstPart.substring(0, firstPart.indexOf(">"));
  return await getSlackUser(userId);
}
