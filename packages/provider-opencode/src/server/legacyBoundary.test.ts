import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import {
  ProviderDriverKind,
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import { resolveLegacyOpenCodeBoundary, type LegacyOpenCodeMessage } from "./legacyBoundary.ts";

const turn = (ordinal: number, withEvidence: boolean): OrchestrationV2ProviderTurn => ({
  id: ProviderTurnId.make(`v1-${ordinal}`),
  providerThreadId: ProviderThreadId.make("v1-thread"),
  nodeId: NodeId.make(`node-${ordinal}`),
  runAttemptId: null,
  nativeTurnRef: null,
  ordinal,
  status: "completed",
  startedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
  completedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
  historyOrigin: "v1_import",
  legacyOpenCodeBoundary: {
    retainedTurnCount: ordinal,
    turnCount: 3,
    messagePartIds: withEvidence ? [`part-a${ordinal}`] : [],
    toolCallIds: [],
  },
});
const message = (id: string, role: string, parentID?: string): LegacyOpenCodeMessage => ({
  info: { id, role, ...(parentID ? { parentID } : {}) },
  parts: role === "assistant" ? [{ id: `part-${id}` }] : [],
});
const history = [
  message("u1", "user"),
  message("a1", "assistant", "u1"),
  message("u2", "user"),
  message("a2", "assistant", "u2"),
  message("u3", "user"),
  message("a3", "assistant", "u3"),
  message("a3-tool", "assistant", "u3"),
];

// Frozen V1 readThread/rollback selection from d2866cb844, OpenCodeAdapter:3915-3955.
const v1Boundary = (messages: ReadonlyArray<LegacyOpenCodeMessage>, numTurns: number) => {
  const turns = messages.filter(({ info }) => info.role === "assistant");
  const target = turns[Math.max(0, turns.length - numTurns)];
  if (!target) return undefined;
  const index = messages.findIndex(({ info }) => info.id === target.info.id);
  return (
    messages.slice(0, index + 1).findLast(({ info }) => info.role === "user") ?? messages[index]
  )?.info.id;
};

it("reproduces V1's ambiguous count-only rewind and refuses its file/conversation mismatch", () => {
  // V1 subtracts two application turns from FOUR assistant messages. It keeps
  // turn 2 while the requested checkpoint restores turn 1's files.
  assert.equal(v1Boundary(history, 2), "u3");
  const turns = [1, 2, 3].map((ordinal) => turn(ordinal, false));
  assert.throws(
    () => resolveLegacyOpenCodeBoundary(history, turns[0]!, turns),
    "unambiguous native boundary",
  );
  // Persisted part ownership recovers the intended boundary without counting
  // an assistant tool step as a new application turn.
  const anchored = [1, 2, 3].map((ordinal) => turn(ordinal, true));
  assert.deepEqual(resolveLegacyOpenCodeBoundary(history, anchored[0]!, anchored), {
    headMessageId: "a1",
    userMessageId: "u1",
    nextUserMessageId: "u2",
  });
});

it("matches V1 for a recoverable count-only history, including first rollback after V2 continuation", () => {
  const simple = history.slice(0, -1);
  assert.equal(v1Boundary(simple, 1), "u3");
  const turns = [1, 2, 3].map((ordinal) => turn(ordinal, false));
  const newTurn = {
    ...turn(4, false),
    historyOrigin: undefined,
    legacyOpenCodeBoundary: undefined,
    nativeTurnRef: {
      driver: ProviderDriverKind.make("opencode"),
      nativeId: "u4",
      strength: "strong" as const,
    },
  };
  const continued = [...simple, message("u4", "user"), message("a4", "assistant", "u4")];
  assert.deepEqual(resolveLegacyOpenCodeBoundary(continued, turns[1]!, [...turns, newTurn]), {
    headMessageId: "a2",
    userMessageId: "u2",
    nextUserMessageId: "u3",
  });
});
