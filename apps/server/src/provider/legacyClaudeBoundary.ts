/** V1 recorded the user message starting each application turn, not its final
 * assistant UUID. Resolve the preceding native message, exactly as V1 rollback
 * did, and refuse missing boundaries rather than resetting the conversation. */
export function resolveLegacyClaudeBoundary(
  messages: ReadonlyArray<{ readonly uuid: string; readonly type: string }>,
  boundary: {
    readonly nextUserMessageId?: string | undefined;
    readonly headMessageId?: string | undefined;
  },
): string {
  if (boundary.nextUserMessageId) {
    const index = messages.findIndex((message) => message.uuid === boundary.nextUserMessageId);
    if (
      index > 0 &&
      messages[index]?.type === "user" &&
      messages[index - 1]?.type === "assistant"
    ) {
      return messages[index - 1]!.uuid;
    }
  } else if (
    boundary.headMessageId &&
    messages.some(
      (message) => message.uuid === boundary.headMessageId && message.type === "assistant",
    )
  ) {
    return boundary.headMessageId;
  }
  throw new Error(
    "The imported Claude checkpoint's exact message boundary is absent from native history. No rollback was performed.",
  );
}
