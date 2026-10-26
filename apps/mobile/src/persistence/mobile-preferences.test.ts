import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import { MobileDatabase, type StoredPreferencesJson } from "./mobile-database";
import { make } from "./mobile-preferences";
import { MobileSecureStorage } from "./mobile-secure-storage";

/** The device preference blob, kept in memory the way the SQLite row would be. */
function makeStores(initialPayload?: string) {
  let stored: StoredPreferencesJson | null =
    initialPayload === undefined ? null : { payload: initialPayload, updatedAt: 1 };
  const unused = Effect.die("not used by preferences");
  const database = MobileDatabase.of({
    loadCache: () => unused,
    listCache: () => unused,
    saveCache: () => unused,
    removeCache: () => unused,
    clearCacheKind: () => unused,
    clearEnvironmentCache: () => unused,
    clearAllCaches: unused,
    inspectCaches: unused,
    loadPreferencesJson: Effect.sync(() => (stored === null ? Option.none() : Option.some(stored))),
    savePreferencesJson: (payload, updatedAt) =>
      Effect.sync(() => {
        stored = { payload, updatedAt };
      }),
  });
  const secureStorage = MobileSecureStorage.of({
    getItem: () => Effect.succeed(null),
    setItem: () => Effect.void,
    removeItem: () => Effect.void,
  });
  const openStore = make().pipe(
    Effect.provideService(MobileDatabase, database),
    Effect.provideService(MobileSecureStorage, secureStorage),
  );
  return { openStore };
}

describe("mobile preferences: opened worker groups", () => {
  it.effect("keeps the groups the user opened through other saves and an app restart", () =>
    Effect.gen(function* () {
      const stores = makeStores();
      const store = yield* stores.openStore;
      const opened = ["environment-1:first", "environment-2:first"];
      yield* store.savePatch({ expandedSessionMasters: opened });
      // An unrelated preference change must not undo the choice.
      yield* store.update(() => ({ baseFontSize: 17 }));
      expect(yield* store.load).toEqual({ baseFontSize: 17, expandedSessionMasters: opened });

      // A new store over the same saved bytes is what a restart sees.
      const restarted = yield* stores.openStore;
      expect((yield* restarted.load).expandedSessionMasters).toEqual(opened);
    }),
  );

  it.effect("leaves every group closed for a device that never opened one", () =>
    Effect.gen(function* () {
      const store = yield* makeStores(JSON.stringify({ baseFontSize: 16 })).openStore;
      expect((yield* store.load).expandedSessionMasters).toBeUndefined();
    }),
  );

  it.effect("ignores saved entries that are not session keys", () =>
    Effect.gen(function* () {
      const payload = JSON.stringify({ expandedSessionMasters: ["environment-1:first", 3, null] });
      const store = yield* makeStores(payload).openStore;
      expect((yield* store.load).expandedSessionMasters).toEqual(["environment-1:first"]);
    }),
  );
});
