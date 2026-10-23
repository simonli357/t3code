import { ComputerInspection } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const Snapshot = Schema.Struct({
  overview: Schema.NullOr(ComputerInspection),
  files: Schema.NullOr(ComputerInspection),
  activity: Schema.NullOr(ComputerInspection),
  /** When this browser last read the file index, on its own clock; a computer's clock may differ. */
  filesReadAt: Schema.NullOr(Schema.Number),
});
export type ComputerCache = typeof Snapshot.Type;
const decodeSnapshot = Schema.decodeUnknownSync(Snapshot);

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("t3-computers", 1);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore("snapshots"));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

export async function readComputerCache(environmentId: string): Promise<ComputerCache | null> {
  const db = await open();
  try {
    const sections = ["overview", "files", "activity", "filesReadAt"] as const;
    const store = db.transaction("snapshots").objectStore("snapshots");
    const values = await Promise.all(
      sections.map(
        (section) =>
          new Promise<unknown>((resolve, reject) => {
            const request = store.get([environmentId, section]);
            request.addEventListener("success", () => resolve(request.result ?? null));
            request.addEventListener("error", () => reject(request.error));
          }),
      ),
    );
    return values.every((value) => value === null)
      ? null
      : decodeSnapshot(
          Object.fromEntries(sections.map((section, index) => [section, values[index]])),
        );
  } finally {
    db.close();
  }
}

export async function writeComputerCache(
  environmentId: string,
  value: Partial<ComputerCache>,
  signal?: AbortSignal,
) {
  if (signal?.aborted) return;
  const db = await open();
  try {
    if (signal?.aborted) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("snapshots", "readwrite");
      const abort = () => transaction.abort();
      signal?.addEventListener("abort", abort, { once: true });
      transaction.addEventListener("complete", () => signal?.removeEventListener("abort", abort));
      transaction.addEventListener("abort", () => signal?.removeEventListener("abort", abort));
      const store = transaction.objectStore("snapshots");
      for (const [section, snapshot] of Object.entries(value))
        store.put(snapshot, [environmentId, section]);
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("error", () => reject(transaction.error));
      transaction.addEventListener("abort", () =>
        reject(transaction.error ?? new Error("Cache write aborted")),
      );
    });
  } finally {
    db.close();
  }
}
