import type { OrchestrationV2ProviderTurn } from "@t3tools/contracts";

export interface LegacyOpenCodeMessage {
  readonly info: { readonly id: string; readonly role: string; readonly parentID?: string };
  readonly parts: ReadonlyArray<{
    readonly id: string;
    readonly type?: string;
    readonly callID?: string;
  }>;
}

/** V1 application turn IDs are local UUIDs. Native part/call IDs can establish
 * ownership; otherwise only a one-user/one-assistant sequence with agreeing
 * checkpoint counts is recoverable. Never interpret a tool step as a turn. */
export function resolveLegacyOpenCodeBoundary(
  messages: ReadonlyArray<LegacyOpenCodeMessage>,
  selected: OrchestrationV2ProviderTurn,
  providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>,
): { headMessageId: string; userMessageId: string; nextUserMessageId?: string } {
  const fail = (): never => {
    throw new Error(
      "The imported OpenCode checkpoint has no unambiguous native boundary. No rollback was performed.",
    );
  };
  const boundary = selected.legacyOpenCodeBoundary;
  if (!boundary || new Set(messages.map(({ info }) => info.id)).size !== messages.length)
    return fail();
  const resultAt = (index: number) => {
    const head = messages[index];
    const next = messages[index + 1];
    const user = messages.slice(0, index + 1).findLast(({ info }) => info.role === "user");
    if (!head || head.info.role !== "assistant" || !user || (next && next.info.role !== "user"))
      return fail();
    return {
      headMessageId: head.info.id,
      userMessageId: user.info.id,
      ...(next ? { nextUserMessageId: next.info.id } : {}),
    };
  };
  if (boundary.headMessageId)
    return resultAt(messages.findIndex(({ info }) => info.id === boundary.headMessageId));
  // A linked V2 user ID bounds the source prefix even if rollback is first used
  // after continuation. No timestamp matching or ordinal-as-native-ID guessing.
  const continuation = providerTurns
    .filter(
      (turn) =>
        turn.providerThreadId === selected.providerThreadId &&
        turn.historyOrigin !== "v1_import" &&
        turn.ordinal > selected.ordinal &&
        turn.nativeTurnRef?.nativeId,
    )
    .toSorted((a, b) => a.ordinal - b.ordinal)[0];
  const end = continuation
    ? messages.findIndex(
        ({ info }) => info.id === continuation.nativeTurnRef?.nativeId && info.role === "user",
      )
    : messages.length;
  if (end < 0) return fail();
  const source = messages.slice(0, end);
  const imported = providerTurns
    .filter(
      (turn) => turn.providerThreadId === selected.providerThreadId && turn.legacyOpenCodeBoundary,
    )
    .toSorted((a, b) => a.ordinal - b.ordinal);
  const groups: Array<{ start: number; end: number; owner: number | undefined }> = [];
  for (const [index, message] of source.entries()) {
    if (message.info.role === "user") groups.push({ start: index, end: index, owner: undefined });
    else if (message.info.role !== "assistant" || !groups.length) return fail();
    const group = groups.at(-1)!;
    group.end = index;
    if (message.info.role !== "assistant") continue;
    if (message.info.parentID && message.info.parentID !== source[group.start]!.info.id)
      return fail();
    const owners = imported.filter((turn) =>
      message.parts.some(
        (part) =>
          turn.legacyOpenCodeBoundary!.messagePartIds.includes(part.id) ||
          (part.callID !== undefined &&
            turn.legacyOpenCodeBoundary!.toolCallIds.includes(part.callID)),
      ),
    );
    if (owners.length > 1) return fail();
    if (owners[0]) {
      const owner = owners[0].legacyOpenCodeBoundary!.retainedTurnCount;
      if (group.owner !== undefined && group.owner !== owner) return fail();
      group.owner = owner;
    }
  }
  const hasEvidence = imported.some(
    (turn) =>
      turn.legacyOpenCodeBoundary!.messagePartIds.length ||
      turn.legacyOpenCodeBoundary!.toolCallIds.length,
  );
  if (!hasEvidence) {
    if (
      groups.length !== boundary.turnCount ||
      groups.some((group) => group.end !== group.start + 1)
    )
      return fail();
    groups.forEach((group, index) => {
      group.owner = index + 1;
    });
  }
  if (
    groups.some(
      (group, index) =>
        group.owner === undefined ||
        group.owner < 1 ||
        group.owner > boundary.turnCount ||
        group.end === group.start ||
        (index > 0 && group.owner < groups[index - 1]!.owner!),
    ) ||
    new Set(groups.map((group) => group.owner)).size !== boundary.turnCount
  )
    return fail();
  const retained = groups.findLast((group) => group.owner === boundary.retainedTurnCount);
  return retained ? resultAt(retained.end) : fail();
}
