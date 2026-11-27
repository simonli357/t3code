import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  ConnectionTransientError,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import {
  ConnectionCatalogDocument,
  registerConnectionInCatalog,
  setConnectionEnabledInCatalog,
} from "@t3tools/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { afterEach, vi } from "vite-plus/test";

import {
  makeBrowserGitHubRoutingPermissions,
  makeCatalogBackend,
  makeCatalogStore,
} from "./storage";

const emptyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
  disabledEnvironmentIds: [],
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));
const encodeCatalog = Schema.encodeSync(Schema.fromJsonString(ConnectionCatalogDocument));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("makeCatalogStore", () => {
  it.effect("a late write from another tab preserves a direct pairing across reload", () =>
    Effect.gen(function* () {
      const pairing = (name: string) => {
        const environmentId = EnvironmentId.make(name);
        const connectionId = `bearer:${name}`;
        return new BearerConnectionRegistration({
          target: new BearerConnectionTarget({ environmentId, connectionId, label: name }),
          profile: new BearerConnectionProfile({
            environmentId,
            connectionId,
            label: name,
            httpBaseUrl: `https://${name}.example.test`,
            wsBaseUrl: `wss://${name}.example.test`,
          }),
          credential: new BearerConnectionCredential({ token: `test-token-${name}` }),
        });
      };
      const first = pairing("first");
      const second = pairing("second");
      let raw = encodeCatalog(registerConnectionInCatalog(emptyCatalog, first));
      const backend = {
        read: Effect.sync(() => raw),
        write: (next: string, expected: string | null) =>
          Effect.sync(() => {
            if (raw !== expected) return false;
            raw = next;
            return true;
          }),
      };
      const writing = yield* Deferred.make<void>();
      const resumeWrite = yield* Deferred.make<void>();
      const olderTab = yield* makeCatalogStore({
        ...backend,
        write: (next, expected) =>
          Deferred.succeed(writing, undefined).pipe(
            Effect.andThen(Deferred.await(resumeWrite)),
            Effect.andThen(backend.write(next, expected)),
          ),
      });
      yield* olderTab.read;
      const late = yield* olderTab
        .update((doc) => setConnectionEnabledInCatalog(doc, first.target.environmentId, false))
        .pipe(Effect.forkChild);
      yield* Deferred.await(writing);
      const pairingTab = yield* makeCatalogStore(backend);
      yield* pairingTab.update((doc) => registerConnectionInCatalog(doc, second));
      yield* Deferred.succeed(resumeWrite, undefined);
      yield* Fiber.join(late);

      const reloaded = yield* (yield* makeCatalogStore(backend)).read;
      expect(reloaded.targets).toEqual([first.target, second.target]);
      expect(reloaded.profiles).toContainEqual(second.profile);
      expect(reloaded.credentials).toContainEqual({
        connectionId: second.target.connectionId,
        credential: second.credential,
      });
      expect(reloaded.disabledEnvironmentIds).toEqual([first.target.environmentId]);
    }),
  );

  it.effect("quarantines malformed catalogs and starts from an empty document", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const quarantined: string[] = [];
      const store = yield* makeCatalogStore({
        read: Effect.succeed("{not-json"),
        write: (raw) =>
          Effect.sync(() => {
            writes.push(raw);
            return true;
          }),
        quarantine: (raw) => Effect.sync(() => quarantined.push(raw)),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(quarantined).toEqual(["{not-json"]);
      expect(writes).toHaveLength(1);
      expect(decodeCatalog(writes[0]!)).toEqual(emptyCatalog);
    }),
  );

  it.effect("does not hide catalog read failures", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "permission denied",
      });
      const store = yield* makeCatalogStore({
        read: Effect.fail(failure),
        write: () => Effect.succeed(true),
      });

      expect(yield* Effect.flip(store.read)).toBe(failure);
    }),
  );
});

describe("makeCatalogBackend", () => {
  it.effect("fails writes when desktop secure storage declines the catalog", () =>
    Effect.gen(function* () {
      const setConnectionCatalog = vi.fn().mockResolvedValue(false);
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: vi.fn().mockResolvedValue(null),
          setConnectionCatalog,
        },
      });
      const backend = makeCatalogBackend({} as IDBDatabase);

      const error = yield* backend.write("{}", null).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("Desktop secure storage is unavailable");
      expect(setConnectionCatalog).toHaveBeenCalledWith("{}");
    }),
  );

  it.effect("a newer IndexedDB document makes a stale writer retry without overwriting it", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const request = Object.assign(new EventTarget(), { result: "newer catalog" });
      const put = vi.fn();
      const transaction = Object.assign(new EventTarget(), {
        objectStore: () => ({
          get: () => {
            queueMicrotask(() => {
              request.dispatchEvent(new Event("success"));
              transaction.dispatchEvent(new Event("complete"));
            });
            return request;
          },
          put,
        }),
      });
      const backend = makeCatalogBackend({ transaction: () => transaction } as never);
      expect(yield* backend.write("replacement", "older catalog")).toBe(false);
      expect(put).not.toHaveBeenCalled();
    }),
  );

  it.effect("fails IndexedDB writes whose commit aborts", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const transaction = Object.assign(new EventTarget(), {
        error: null as DOMException | null,
        objectStore: () => ({
          get: () => {
            const request = Object.assign(new EventTarget(), { result: undefined });
            queueMicrotask(() => request.dispatchEvent(new Event("success")));
            return request;
          },
          put: () => {
            // A failed commit aborts the transaction without an "error" event.
            queueMicrotask(() => {
              transaction.error = new DOMException("Quota exceeded", "QuotaExceededError");
              transaction.dispatchEvent(new Event("abort"));
            });
          },
        }),
      });
      const backend = makeCatalogBackend({ transaction: () => transaction } as never);

      const error = yield* backend.write("{}", null).pipe(Effect.flip);

      expect(error.message).toContain("QuotaExceededError");
    }),
  );
});

describe("browser GitHub routing permissions", () => {
  it.effect("revokes across runtimes before storage events and resists stale catalog writes", () =>
    Effect.gen(function* () {
      const values = new Map<string, string>();
      const localStorage: Storage = {
        get length() {
          return values.size;
        },
        key: (index) => [...values.keys()][index] ?? null,
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value);
        },
        removeItem: (key) => {
          values.delete(key);
        },
        clear: () => {
          values.clear();
        },
      };
      const firstBrowser = Object.assign(new EventTarget(), { localStorage });
      const secondBrowser = Object.assign(new EventTarget(), { localStorage });
      const first = makeBrowserGitHubRoutingPermissions(firstBrowser);
      const second = makeBrowserGitHubRoutingPermissions(secondBrowser);
      const entry = {
        target: new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make("first"),
          label: "First",
          httpBaseUrl: "http://localhost:3000",
          wsBaseUrl: "ws://localhost:3000",
        }),
        profile: Option.none(),
        enabled: true,
      };
      const other = {
        ...entry,
        target: new PrimaryConnectionTarget({
          ...entry.target,
          environmentId: EnvironmentId.make("second"),
        }),
      };
      expect(yield* first.get(entry)).toBe("off");
      yield* first.set(entry, "read-write");
      expect(yield* second.get(entry)).toBe("read-write");
      const oldPermissions = Option.getOrThrow(yield* Stream.runHead(first.changes));
      const staleCatalog = yield* makeCatalogStore({
        read: Effect.succeed(
          encodeCatalog({ ...emptyCatalog, githubRoutingPermissions: oldPermissions }),
        ),
        write: () => Effect.succeed(true),
      });
      yield* staleCatalog.read;
      const listening = yield* Deferred.make<void>();
      const revoked = yield* Deferred.make<void>();
      yield* second.changes.pipe(
        Stream.runForEach((permissions) =>
          Deferred.succeed(permissions.length > 0 ? listening : revoked, undefined),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(listening);

      yield* first.set(entry, "off");
      expect(yield* second.get(entry)).toBe("off");
      secondBrowser.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
      yield* Deferred.await(revoked);
      yield* second.set(other, "read");
      yield* staleCatalog.update((document) => ({ ...document, accountId: "updated" }));
      expect(yield* second.get(entry)).toBe("off");
      expect(yield* first.get(other)).toBe("read");
      expect(yield* makeBrowserGitHubRoutingPermissions(firstBrowser).get(entry)).toBe("off");

      yield* first.set(entry, "read-write");
      yield* second.forget(entry.target.environmentId);
      expect(yield* first.get(entry)).toBe("off");
      expect(yield* first.get(other)).toBe("read");
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("Storage unavailable");
      });
      expect(yield* first.set(entry, "read-write").pipe(Effect.flip)).toBeInstanceOf(
        ConnectionTransientError,
      );
      expect(yield* second.get(entry)).toBe("off");
    }).pipe(Effect.scoped),
  );
});
