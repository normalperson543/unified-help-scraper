export const FORWARD_EVENT_TYPE = "nephthys_plus_forward";

export type MessageMetadata = {
  event_type: string;
  event_payload?: { source_user_id?: unknown; ticket?: unknown };
};

export function getForwardedTicketUser(
  metadata: MessageMetadata | undefined,
): string | undefined {
  if (metadata?.event_type !== FORWARD_EVENT_TYPE) return undefined;
  const payload = metadata.event_payload;
  if (payload?.ticket !== true) return undefined;
  return typeof payload.source_user_id === "string"
    ? payload.source_user_id
    : undefined;
}
