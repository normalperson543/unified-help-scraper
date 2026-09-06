// AI written code

import type { WebClient } from "@slack/web-api";

const STATUS_REACTION_EMOJIS = ["white_check_mark", "thinking_face"];

/**
 * Keep exactly one status reaction on a ticket's parent Slack message:
 * - :white_check_mark: for resolved tickets (status === 2)
 * - :thinking_face: for open/assigned/reopened tickets (status !== 2)
 *
 * Any existing status reaction that doesn't match the current status is removed.
 */
export async function syncTicketReaction(
  client: WebClient,
  channelId: string,
  messageTs: string,
  status: number,
) {
  const desiredEmoji = status === 2 ? "white_check_mark" : "thinking_face";

  try {
    const reactionsRes = await client.reactions.get({
      channel: channelId,
      timestamp: messageTs,
      full: true,
    });

    const reactions = reactionsRes.message?.reactions ?? [];
    const existingEmojis = new Set(
      reactions.map((r) => r.name).filter((name): name is string => !!name),
    );

    const hasDesired = existingEmojis.has(desiredEmoji);

    for (const name of STATUS_REACTION_EMOJIS) {
      if (name === desiredEmoji) continue;
      if (!existingEmojis.has(name)) continue;
      try {
        await client.reactions.remove({
          channel: channelId,
          timestamp: messageTs,
          name,
        });
      } catch (e) {
        console.warn(`Failed to remove reaction :${name}:`, e);
      }
    }

    if (!hasDesired) {
      await client.reactions.add({
        channel: channelId,
        timestamp: messageTs,
        name: desiredEmoji,
      });
    }
  } catch (e) {
    console.error("Error syncing ticket reaction:", e);
  }
}
