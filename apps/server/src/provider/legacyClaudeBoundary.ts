export interface LegacyClaudeMessage {
  readonly uuid: string;
  readonly type: string;
  readonly parent_tool_use_id?: string | null | undefined;
  readonly message?: unknown;
}

// Match V1's native history classifier. Tool results and child-agent prompts do
// not start application turns. Extra human prompts (steers) invalidate counts.
const isHumanTurnStart = (message: LegacyClaudeMessage): boolean => {
  if (message.type !== "user" || message.parent_tool_use_id !== null) return false;
  const body = message.message;
  if (typeof body !== "object" || body === null || !("content" in body)) return false;
  const content = body.content;
  return (
    typeof content === "string" ||
    (Array.isArray(content) &&
      content.some(
        (part: unknown) =>
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type !== "tool_result",
      ))
  );
};

/** V1 recorded the user message starting each application turn, not its final
 * assistant UUID. Resolve the preceding native message, exactly as V1 rollback
 * did, and refuse missing boundaries rather than resetting the conversation. */
export function resolveLegacyClaudeBoundary(
  messages: ReadonlyArray<LegacyClaudeMessage>,
  boundary: {
    readonly nextUserMessageId?: string | undefined;
    readonly headMessageId?: string | undefined;
    readonly recoverTurnStarts?:
      | {
          readonly retainedTurnCount: number;
          readonly turnCount: number;
          readonly sourceHeadMessageId?: string | undefined;
        }
      | undefined;
  },
): string {
  if (new Set(messages.map((message) => message.uuid)).size !== messages.length)
    throw new Error("Ambiguous Claude native message IDs. No rollback was performed.");
  if (boundary.recoverTurnStarts) {
    const recovery = boundary.recoverTurnStarts;
    const headIndex = recovery.sourceHeadMessageId
      ? messages.findIndex((message) => message.uuid === recovery.sourceHeadMessageId)
      : messages.length - 1;
    const source = messages.slice(0, headIndex + 1);
    const starts = source.filter(isHumanTurnStart);
    if (
      headIndex >= 0 &&
      starts.length === recovery.turnCount &&
      recovery.retainedTurnCount > 0 &&
      recovery.retainedTurnCount <= recovery.turnCount
    ) {
      return resolveLegacyClaudeBoundary(
        source,
        recovery.retainedTurnCount < recovery.turnCount
          ? { nextUserMessageId: starts[recovery.retainedTurnCount]!.uuid }
          : { headMessageId: source.at(-1)!.uuid },
      );
    }
    throw new Error(
      "The V1 Claude turn count does not match unambiguous native human-turn starts. No rollback was performed.",
    );
  }
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
