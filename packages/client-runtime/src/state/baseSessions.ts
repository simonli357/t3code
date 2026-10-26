import { ClientThreadTurnStartCommand, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { StartThreadTurnInput } from "../operations/commands.ts";

export const DEFAULT_BASE_PROMPT = "Understand project";
export const BASE_GROUP_KEY = "base-sessions";
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ClientThreadTurnStartCommand));
const encode = Schema.encodeSync(Schema.fromJsonString(ClientThreadTurnStartCommand));
export type BaseSubmissionStorage = {
  readonly read: () => Promise<string | null>;
  readonly write: (value: string) => Promise<void>;
  readonly clear: () => Promise<void>;
};

/** Save before network IO. Retain the exact request across failures, app restarts
 * and restored drafts. A changed draft cannot replace an unresolved request. */
export async function retainBaseSubmission(
  storage: BaseSubmissionStorage,
  input: StartThreadTurnInput,
) {
  if (!input.commandId || !input.createdAt)
    throw new Error("Base submissions require stable command IDs and timestamps.");
  const command = {
    ...input,
    type: "thread.turn.start" as const,
    commandId: input.commandId,
    createdAt: input.createdAt,
  };
  const previous = await storage.read();
  if (previous !== null) {
    const saved = decode(previous);
    const content = (value: typeof saved) =>
      JSON.stringify({
        threadId: value.threadId,
        initializeBase: value.initializeBase,
        text: value.message.text,
        attachments: value.message.attachments,
        context: value.message.context,
      });
    if (content(saved) !== content(command))
      throw new Error(
        "A previous Base submission is unresolved. Use Check previous task in Session organization to inspect the same fork before discarding the saved request.",
      );
    return saved;
  }
  await storage.write(encode(command));
  return command;
}

/** Inspect/retry the exact retained request, including its original attachment IDs. */
export async function readBaseSubmission(storage: BaseSubmissionStorage) {
  const saved = await storage.read();
  return saved === null ? null : decode(saved);
}

const decodeConfirmation = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ confirmedThreadId: Schema.optional(ThreadId) })),
);

/** Confirmation belongs to the saved request. Opening a confirmed destination
 * must never repeat delivery, even after a reload or a route-loading failure. */
async function confirmBaseDelivery(
  storage: BaseSubmissionStorage,
  deliver: () => Promise<ThreadId>,
) {
  const saved = await storage.read();
  if (saved === null) throw new Error("The saved Base request is unavailable.");
  const confirmation = decodeConfirmation(saved).confirmedThreadId;
  if (confirmation) return confirmation;
  const destination = await deliver();
  await storage.write(JSON.stringify({ ...JSON.parse(saved), confirmedThreadId: destination }));
  return destination;
}

export async function openBaseDestination(
  storage: BaseSubmissionStorage,
  deliver: () => Promise<ThreadId>,
  open: (destination: ThreadId) => Promise<unknown> | void,
) {
  const destination = await confirmBaseDelivery(storage, deliver);
  try {
    await open(destination);
  } catch (cause) {
    throw new Error(
      `Base request completed in session ${destination}, but opening it failed: ${cause instanceof Error ? cause.message : String(cause)}. Retry to open the existing session without sending again.`,
      { cause },
    );
  }
  return destination;
}
