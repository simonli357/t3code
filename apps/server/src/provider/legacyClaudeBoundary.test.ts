import { describe, expect, it } from "@effect/vitest";
import { resolveLegacyClaudeBoundary } from "./legacyClaudeBoundary.ts";

describe("legacy Claude rollback boundaries", () => {
  const history = [
    { uuid: "u1", type: "user" },
    { uuid: "a1", type: "assistant" },
    { uuid: "u2", type: "user" },
    { uuid: "a2", type: "assistant" },
    { uuid: "u3", type: "user" },
    { uuid: "a3", type: "assistant" },
  ];
  it("resolves the selected noninitial checkpoint from the next native user message", () => {
    expect(resolveLegacyClaudeBoundary(history, { nextUserMessageId: "u3" })).toBe("a2");
    expect(resolveLegacyClaudeBoundary(history, { headMessageId: "a2" })).toBe("a2");
  });
  it("refuses missing, initial, and wrong-role boundaries", () => {
    for (const boundary of [
      { nextUserMessageId: "missing" },
      { nextUserMessageId: "u1" },
      { nextUserMessageId: "a3" },
      { headMessageId: "u2" },
      {},
    ]) {
      expect(() => resolveLegacyClaudeBoundary(history, boundary)).toThrow(
        "No rollback was performed",
      );
    }
  });
});

describe("V1 null-marker recovery", () => {
  const human = (uuid: string) => ({
    uuid,
    type: "user",
    parent_tool_use_id: null,
    message: { content: "prompt" },
  });
  const history = [
    human("u1"),
    { uuid: "a1", type: "assistant" },
    human("u2"),
    {
      uuid: "tool-result",
      type: "user",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result" }] },
    },
    {
      uuid: "child",
      type: "user",
      parent_tool_use_id: "tool",
      message: { content: "child prompt" },
    },
    { uuid: "a2", type: "assistant" },
    human("u3"),
    { uuid: "a3", type: "assistant" },
  ];
  const boundary = {
    recoverTurnStarts: { retainedTurnCount: 2, turnCount: 3, sourceHeadMessageId: "a3" },
  };
  it("matches V1 all-null recovery, ignores tool results/child prompts and bounds later V2 continuation", () => {
    expect(resolveLegacyClaudeBoundary(history, boundary)).toBe("a2");
    expect(
      resolveLegacyClaudeBoundary(
        [...history, human("u4"), { uuid: "a4", type: "assistant" }],
        boundary,
      ),
    ).toBe("a2");
  });
  it("refuses the same steer/count ambiguity that V1 refused", () => {
    const steered = [...history.slice(0, 3), human("steer"), ...history.slice(3)];
    expect(() => resolveLegacyClaudeBoundary(steered, boundary)).toThrow("turn count");
    expect(() => resolveLegacyClaudeBoundary(history.slice(2), boundary)).toThrow("turn count");
    expect(() => resolveLegacyClaudeBoundary([...history, history[0]!], boundary)).toThrow(
      "Ambiguous",
    );
  });
});
