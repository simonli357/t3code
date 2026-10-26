import { describe, expect, it } from "vite-plus/test";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { retainBaseSubmission, readBaseSubmission, openBaseDestination } from "./baseSessions.ts";
const input = {
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  commandId: CommandId.make("request-1"),
  threadId: ThreadId.make("base"),
  message: {
    messageId: MessageId.make("message-1"),
    role: "user" as const,
    text: "Use the remembered project",
    attachments: [],
  },
  createdAt: "2026-10-24T12:00:00Z",
};
describe("durable Base drafts", () => {
  it("retains a rejected delivery and retries only its original request", async () => {
    let saved: string | null = null;
    const storage = {
      read: async () => saved,
      write: async (value: string) => {
        saved = value;
      },
      clear: async () => {
        saved = null;
      },
    };
    const request = await retainBaseSubmission(storage, input);
    let opens = 0;
    await expect(
      openBaseDestination(
        storage,
        async () => {
          throw new Error("Image rejected");
        },
        () => {
          opens++;
        },
      ),
    ).rejects.toThrow("Image rejected");
    expect(opens).toBe(0);
    expect(await readBaseSubmission(storage)).toEqual(request);
  });
  it("persists confirmation across reload and never delivers again when reopening", async () => {
    let saved: string | null = null;
    const storage = {
      read: async () => saved,
      write: async (value: string) => {
        saved = value;
      },
      clear: async () => {
        saved = null;
      },
    };
    await retainBaseSubmission(storage, input);
    let deliveries = 0;
    const deliver = async () => {
      deliveries++;
      return ThreadId.make("confirmed");
    };
    await expect(
      openBaseDestination(storage, deliver, async () => {
        throw new Error("Route failed");
      }),
    ).rejects.toThrow("Base request completed");
    const restored = await retainBaseSubmission(storage, {
      ...input,
      commandId: CommandId.make("another-click"),
    });
    expect(restored.commandId).toBe(input.commandId);
    const opened: ThreadId[] = [];
    await openBaseDestination({ ...storage }, deliver, (destination) => {
      opened.push(destination);
    });
    expect(deliveries).toBe(1);
    expect(opened).toEqual(["confirmed"]);
    expect(saved).not.toBeNull();
  });
  it("retains exact request after failure/reload and clears only after a confirmed fork", async () => {
    let saved: string | null = null;
    const storage = {
      read: async () => saved,
      write: async (value: string) => {
        saved = value;
      },
      clear: async () => {
        saved = null;
      },
    };
    const first = await retainBaseSubmission(storage, input);
    // Simulate an uncertain network response followed by composer restoration.
    const restored = await retainBaseSubmission(storage, {
      ...input,
      commandId: CommandId.make("new-click"),
      message: { ...input.message, messageId: MessageId.make("new-ui-id") },
      createdAt: "2026-10-25T12:00:00Z",
    });
    expect(restored).toEqual(first);
    expect(await readBaseSubmission(storage)).toEqual(first);
    await expect(
      retainBaseSubmission(storage, {
        ...input,
        message: { ...input.message, text: "A different task" },
      }),
    ).rejects.toThrow("unresolved");
    expect(await storage.read()).not.toBeNull();
    await storage.clear();
    expect(
      (await retainBaseSubmission(storage, { ...input, commandId: CommandId.make("next-task") }))
        .commandId,
    ).toBe("next-task");
  });
  it("does not submit when durable draft storage fails", async () => {
    const storage = {
      read: async () => null,
      write: async () => {
        throw new Error("Disk unavailable");
      },
      clear: async () => {},
    };
    await expect(retainBaseSubmission(storage, input)).rejects.toThrow("Disk unavailable");
  });
});
