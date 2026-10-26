import { ComputerInspection, StorageDisks, StorageHoldings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const Snapshot = Schema.Struct({
  overview: Schema.NullOr(ComputerInspection),
  activity: Schema.NullOr(ComputerInspection),
  /** The storage views' last known data; absent in what older versions saved. */
  storageDisks: Schema.optionalKey(Schema.NullOr(StorageDisks)),
  storageHoldings: Schema.optionalKey(Schema.NullOr(StorageHoldings)),
  /** When this browser last read either of them, on its own clock. */
  storageReadAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
export type ComputerCache = typeof Snapshot.Type;
const decodeSnapshot = Schema.decodeUnknownSync(Snapshot);

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("t3-computers", 2);
    request.addEventListener("upgradeneeded", (event) => {
      const store =
        event.oldVersion === 0
          ? request.result.createObjectStore("snapshots")
          : request.transaction!.objectStore("snapshots");
      // Remove legacy full indexes without reading their values into the browser.
      const cursor = store.openKeyCursor();
      cursor.addEventListener("success", () => {
        const entry = cursor.result;
        if (!entry) return;
        if (Array.isArray(entry.key) && ["files", "filesReadAt"].includes(String(entry.key[1])))
          store.delete(entry.key);
        entry.continue();
      });
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

export async function readComputerCache(environmentId: string): Promise<ComputerCache | null> {
  const db = await open();
  try {
    const sections = [
      "overview",
      "activity",
      "storageDisks",
      "storageHoldings",
      "storageReadAt",
    ] as const;
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
