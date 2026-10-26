import { describe, it, expect } from "vite-plus/test";
import { MessageId, type OrchestrationMessage } from "@t3tools/contracts";
import { buildContextHandoff, historyPage } from "./ContextHandoff.ts";

const message = (
  id: string,
  role: OrchestrationMessage["role"],
  text: string,
): OrchestrationMessage => ({
  id: MessageId.make(id),
  role,
  text,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  turnId: null,
  streaming: false,
});
describe("portable handoff", () => {
  it("preserves roles and intact text, excludes reasoning and the current request", () => {
    const result = buildContextHandoff(
      [
        message("first", "user", "Do task A\nexactly."),
        message("hidden", "reasoning", "private reasoning"),
        message("answer", "assistant", "Done A"),
        message("now", "user", "Now do B"),
      ],
      "now",
    );
    expect(result).toContain(
      JSON.stringify({ messageId: "first", role: "user", text: "Do task A\nexactly." }),
    );
    expect(result).toContain('"role":"assistant"');
    expect(result).not.toContain("private reasoning");
    expect(result).not.toContain("Now do B");
  });
  it("bounds UTF-8 bytes while favoring the initial request and newest replies", () => {
    const result = buildContextHandoff([
      message("first", "user", "Original task"),
      message("large", "assistant", "界".repeat(8000)),
      message("new", "assistant", "Newest useful result"),
    ]);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(16000);
    expect(result).toContain("Original task");
    expect(result).toContain("Newest useful result");
    expect(result).toContain("1 messages omitted");
    expect(result).not.toContain("界");
  });
  it("paginates large historical messages without losing text", () => {
    const messages = [
      message("hidden", "system", "private"),
      message("big", "assistant", "x".repeat(17000)),
      message("last", "user", "next"),
    ];
    const first = historyPage(messages, {});
    const next = historyPage(messages, {
      messageIndex: first.nextMessageIndex,
      textOffset: first.nextTextOffset,
    });
    expect(first.messages[0]?.text.length).toBe(16000);
    expect(next.messages.map((m) => m.text).join("")).toBe("x".repeat(1000) + "next");
    expect(next.hasMore).toBe(false);
  });
});
