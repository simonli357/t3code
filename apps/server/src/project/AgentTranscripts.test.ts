import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  findSessionTranscripts,
  resolveDeepseekHarnessTranscriptHome,
  resolveTranscriptHome,
} from "./AgentTranscripts.ts";

const SESSION = "0248b7d6-1ead-447d-894b-5edbafe089df";
const OTHER = "3eb759e7-b92c-43aa-9344-c277e5ca72aa";

const write = Effect.fn(function* (filePath: string, contents = "{}\n") {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, contents);
});

it.layer(NodeServices.layer)("AgentTranscripts", (it) => {
  describe("resolveDeepseekHarnessTranscriptHome", () => {
    it.effect(
      "uses the configured home, then the environment's, then a per-instance directory",
      () =>
        Effect.gen(function* () {
          const dsh = ProviderDriverKind.make("deepseekHarness");
          const state = "/state";
          const instanceId = ProviderInstanceId.make("deepseekHarness");
          expect(
            yield* resolveDeepseekHarnessTranscriptHome(
              { driver: dsh, config: { homePath: "/homes/dsh" } },
              instanceId,
              { DSH_HOME: "/homes/host" },
              state,
            ),
          ).toEqual({ driver: "deepseekHarness", homePath: "/homes/dsh" });
          expect(
            yield* resolveDeepseekHarnessTranscriptHome(
              { driver: dsh, config: {} },
              instanceId,
              { DSH_HOME: "/homes/host" },
              state,
            ),
          ).toEqual({ driver: "deepseekHarness", homePath: "/homes/host" });
          const own = yield* resolveDeepseekHarnessTranscriptHome(
            { driver: dsh, config: {} },
            instanceId,
            {},
            state,
          );
          const other = yield* resolveDeepseekHarnessTranscriptHome(
            { driver: dsh, config: {} },
            ProviderInstanceId.make("deepseekHarness_2"),
            {},
            state,
          );
          expect(own?.homePath.startsWith("/state/providers/deepseek-harness/")).toBe(true);
          expect(own?.homePath).not.toBe(other?.homePath);
          expect(
            yield* resolveDeepseekHarnessTranscriptHome(
              { driver: ProviderDriverKind.make("codex"), config: {} },
              instanceId,
              {},
              state,
            ),
          ).toBeNull();
        }),
    );
  });

  describe("resolveTranscriptHome", () => {
    it.effect("follows homePath, then the instance or host environment, per driver", () =>
      Effect.gen(function* () {
        const claude = ProviderDriverKind.make("claudeAgent");
        const codex = ProviderDriverKind.make("codex");
        expect(
          yield* resolveTranscriptHome(
            { driver: claude, config: { homePath: "/homes/eol" } },
            {
              CLAUDE_CONFIG_DIR: "/homes/host",
            },
          ),
        ).toEqual({ driver: "claudeAgent", homePath: "/homes/eol" });
        expect(
          yield* resolveTranscriptHome(
            {
              driver: claude,
              config: {},
              environment: [
                { name: "CLAUDE_CONFIG_DIR", value: "/homes/instance", sensitive: false },
              ],
            },
            { CLAUDE_CONFIG_DIR: "/homes/host" },
          ),
        ).toEqual({ driver: "claudeAgent", homePath: "/homes/instance" });
        expect(
          yield* resolveTranscriptHome(
            { driver: codex, config: {} },
            { CODEX_HOME: "/homes/codex" },
          ),
        ).toEqual({ driver: "codex", homePath: "/homes/codex" });
        // A shadow home only overlays auth; sessions stay in the shared home.
        expect(
          yield* resolveTranscriptHome(
            {
              driver: codex,
              config: { homePath: "/homes/shared", shadowHomePath: "/homes/shadow" },
            },
            {},
          ),
        ).toEqual({ driver: "codex", homePath: "/homes/shared" });
        expect(
          yield* resolveTranscriptHome(
            { driver: ProviderDriverKind.make("cursor"), config: {} },
            {},
          ),
        ).toBeNull();
      }),
    );
  });

  describe("findSessionTranscripts", () => {
    it.effect("returns only the Claude session file and its sibling directory", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
        const projectA = path.join(home, "projects", "-repo-a");
        const projectB = path.join(home, "projects", "-repo-b");
        yield* write(path.join(projectA, `${SESSION}.jsonl`), "0123456789");
        yield* write(path.join(projectA, SESSION, "subagents", "agent-1.jsonl"), "abcd");
        yield* write(path.join(projectA, SESSION, "tool-results", "r.txt"), "xy");
        yield* write(path.join(projectB, `${SESSION}.jsonl`), "z");
        yield* write(path.join(projectA, `${OTHER}.jsonl`));
        yield* write(path.join(projectA, OTHER, "subagents", "agent-2.jsonl"));
        yield* write(path.join(projectA, "memory", "MEMORY.md"));
        yield* write(path.join(projectA, `${SESSION}.jsonl.bak`));

        const found = yield* findSessionTranscripts(
          { driver: "claudeAgent", homePath: home },
          SESSION,
        );

        expect(found.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
          { path: path.join(projectA, SESSION), bytes: 6 },
          { path: path.join(projectA, `${SESSION}.jsonl`), bytes: 10 },
          { path: path.join(projectB, `${SESSION}.jsonl`), bytes: 1 },
        ]);
        // Ids that are not UUIDs never reach a path, so `memory` cannot match.
        for (const unsafe of ["memory", "../projects", `${SESSION}/..`, ""]) {
          expect(
            yield* findSessionTranscripts({ driver: "claudeAgent", homePath: home }, unsafe),
          ).toEqual([]);
        }
      }),
    );

    it.effect("returns Codex rollouts for the thread id in live and archived sessions", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-home-" });
        const live = path.join(
          home,
          "sessions",
          "2026",
          "10",
          "05",
          `rollout-2026-10-05T12-00-00-${SESSION}.jsonl`,
        );
        const archived = path.join(
          home,
          "archived_sessions",
          `rollout-2026-09-01T08-00-00-${SESSION}.jsonl`,
        );
        yield* write(live, "12345");
        yield* write(archived, "12");
        yield* write(
          path.join(
            home,
            "sessions",
            "2026",
            "10",
            "05",
            `rollout-2026-10-05T12-00-00-${OTHER}.jsonl`,
          ),
        );
        yield* write(path.join(home, "sessions", "2026", "10", "05", `${SESSION}.jsonl`));
        yield* write(path.join(home, "history.jsonl"));

        const found = yield* findSessionTranscripts({ driver: "codex", homePath: home }, SESSION);

        expect(found.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
          { path: archived, bytes: 2 },
          { path: live, bytes: 5 },
        ]);
      }),
    );

    it.effect("returns only the matching DeepSeek Harness session directories", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dsh-home-" });
        const projectA = path.join(home, "sessions", "--repo-a--");
        const projectB = path.join(home, "sessions", "--repo-b--");
        const current = path.join(projectA, SESSION);
        yield* write(path.join(current, "session.v4.jsonl"), "1234");
        yield* write(path.join(projectA, OTHER, "session.v4.jsonl"), "ignored");
        yield* write(path.join(projectB, SESSION, "session.v4.jsonl"), "12");

        const found = yield* findSessionTranscripts(
          { driver: "deepseekHarness", homePath: home },
          SESSION,
        );

        expect(found.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
          { path: current, bytes: 4 },
          { path: path.join(projectB, SESSION), bytes: 2 },
        ]);
        expect(
          yield* findSessionTranscripts(
            { driver: "deepseekHarness", homePath: home },
            "../--repo-a--",
          ),
        ).toEqual([]);
      }),
    );

    it.effect("names a Pi session by its file and only under the sessions directory", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-home-" });
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-outside-" });
        const session = path.join(home, "sessions", "--repo--", "2026-01-01_a.jsonl");
        const sibling = path.join(home, "sessions", "--repo--", "2026-01-01_b.jsonl");
        const settings = path.join(home, "settings.json");
        const elsewhere = path.join(outside, "2026-01-01_c.jsonl");
        yield* write(session, "0123");
        yield* write(sibling);
        yield* write(settings);
        yield* write(elsewhere);
        const pi = { driver: "pi", homePath: home } as const;

        expect(yield* findSessionTranscripts(pi, session)).toEqual([{ path: session, bytes: 4 }]);
        // A path outside the sessions directory, a non-session file, a directory and a
        // traversal never match, however the cursor spells them.
        for (const unsafe of [
          settings,
          elsewhere,
          path.join(home, "sessions", "--repo--"),
          path.join(home, "sessions", "..", "settings.json"),
          path.join(home, "sessions", "--repo--", "..", "..", "settings.json"),
          path.join(home, "sessions", "--repo--", "missing.jsonl"),
          "2026-01-01_a.jsonl",
          "",
        ]) {
          expect(yield* findSessionTranscripts(pi, unsafe)).toEqual([]);
        }
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "does not follow a Pi project directory link out of the sessions directory",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-home-" });
          const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-outside-" });
          yield* write(path.join(outside, "2026-01-01_a.jsonl"));
          yield* fs.makeDirectory(path.join(home, "sessions"), { recursive: true });
          yield* fs.symlink(outside, path.join(home, "sessions", "--linked--"));

          expect(
            yield* findSessionTranscripts(
              { driver: "pi", homePath: home },
              path.join(home, "sessions", "--linked--", "2026-01-01_a.jsonl"),
            ),
          ).toEqual([]);
        }),
    );

    it.effect.skipIf(!symlinksSupported)("never returns or follows symlinks", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-outside-" });
        yield* write(path.join(outside, "precious.jsonl"));
        yield* write(path.join(outside, `${SESSION}.jsonl`));
        const project = path.join(home, "projects", "-repo");
        yield* fs.makeDirectory(project, { recursive: true });
        yield* fs.symlink(
          path.join(outside, "precious.jsonl"),
          path.join(project, `${SESSION}.jsonl`),
        );
        yield* fs.symlink(outside, path.join(project, SESSION));
        yield* fs.symlink(outside, path.join(home, "projects", "-linked-repo"));

        expect(
          yield* findSessionTranscripts({ driver: "claudeAgent", homePath: home }, SESSION),
        ).toEqual([]);
      }),
    );
  });
});
