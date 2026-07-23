import { getSlackUser } from "./data";

export async function getResolver(str: string) {
  const firstPart = str.substring(str.indexOf("<@") + 2);
  const userId = firstPart.substring(0, firstPart.indexOf(">"));
  return await getSlackUser(userId);
}
