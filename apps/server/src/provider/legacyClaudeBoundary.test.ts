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
