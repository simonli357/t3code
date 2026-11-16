import { describe, expect, it, vi } from "vite-plus/test";

import {
  readReloadedForServerVersion,
  reloadForServerVersion,
  resolveStaleClient,
  type StaleClientInput,
} from "./staleClientReload";

const BUILD_A = "0.0.45+custom.52.git.aaaaaaaaaaaa";
const BUILD_B = "0.0.45+custom.52.git.bbbbbbbbbbbb";

const loadedFromBuildA: StaleClientInput = {
  clientVersion: BUILD_A,
  ownServerVersion: BUILD_A,
  servedByOwnServer: true,
  reloadedForServerVersion: null,
  unsavedInput: false,
};

function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

describe("resolveStaleClient", () => {
  it("stays when the own server runs the build the window was loaded with", () => {
    expect(resolveStaleClient(loadedFromBuildA)).toBe("current");
  });

  it("stays while the own server has not reported a build yet", () => {
    expect(resolveStaleClient({ ...loadedFromBuildA, ownServerVersion: null })).toBe("current");
  });

  it("reloads when the own server runs a different build, newer or rolled back", () => {
    expect(resolveStaleClient({ ...loadedFromBuildA, ownServerVersion: BUILD_B })).toBe("reload");
    expect(
      resolveStaleClient({
        ...loadedFromBuildA,
        clientVersion: BUILD_B,
        ownServerVersion: BUILD_A,
      }),
    ).toBe("reload");
  });

  it("prompts instead of reloading while a reload would lose input", () => {
    expect(
      resolveStaleClient({ ...loadedFromBuildA, ownServerVersion: BUILD_B, unsavedInput: true }),
    ).toBe("prompt");
  });

  it("does not reload a second time for the same server build", () => {
    expect(
      resolveStaleClient({
        ...loadedFromBuildA,
        ownServerVersion: BUILD_B,
        reloadedForServerVersion: BUILD_B,
      }),
    ).toBe("current");
  });

  it("never reloads in dev or the desktop app, whose client is not the server's build", () => {
    expect(
      resolveStaleClient({
        ...loadedFromBuildA,
        ownServerVersion: BUILD_B,
        servedByOwnServer: false,
      }),
    ).toBe("current");
  });
});

describe("reloadForServerVersion", () => {
  it("reloads once per server build across page loads", () => {
    const storage = createStorageStub();
    const reload = vi.fn();
    const decide = () =>
      resolveStaleClient({
        ...loadedFromBuildA,
        ownServerVersion: BUILD_B,
        reloadedForServerVersion: readReloadedForServerVersion(() => storage),
      });

    expect(decide()).toBe("reload");
    expect(reloadForServerVersion(BUILD_B, () => storage, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    // The reloaded page still runs build A (say, a cached shell): no loop.
    expect(decide()).toBe("current");
  });

  it("does not reload when storage is blocked, so a mismatch cannot loop", () => {
    const reload = vi.fn();
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };

    expect(reloadForServerVersion(BUILD_B, blocked, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(readReloadedForServerVersion(blocked)).toBeNull();
  });
});
