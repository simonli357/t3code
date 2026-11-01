import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const Request = Schema.Struct({ commandId: CommandId, targetThreadId: ThreadId, created: Schema.Boolean });
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Request));
const encode = Schema.encodeSync(Schema.fromJsonString(Request));
export interface ConversationForkStorage {
  read: () => Promise<string | null>;
  write: (value: string) => Promise<void>;
  clear: () => Promise<void>;
}
/** Save before submitting, acknowledge only after navigation. Transport failures
 * and a lost client response keep the same native clone destination on retry. */
export async function openConversationFork(input: {
  storage: ConversationForkStorage;
  newId: () => string;
  submit: (request: typeof Request.Type) => Promise<void>;
  open: (threadId: ThreadId) => Promise<void>;
}) {
  const saved = await input.storage.read();
  let request = saved ? decode(saved) : { commandId: CommandId.make(input.newId()), targetThreadId: ThreadId.make(input.newId()), created: false };
  if (!saved) await input.storage.write(encode(request));
  if (!request.created) {
    await input.submit(request);
    request = { ...request, created: true };
    await input.storage.write(encode(request));
  }
  await input.open(request.targetThreadId);
  await input.storage.clear();
}
