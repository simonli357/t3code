import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeSignedOutMessage,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  mergeClaudeProcessEnvironment,
  readClaudePlanTier,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("treats empty, ~/.claude, and the expanded default as the same Claude home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(path.join(NodeOS.homedir(), ".claude"));

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: resolved })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);

        const key = `claude:home:${resolved}`;
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "~/.claude" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: resolved })).toBe(key);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it("labels Claude processes t3-code over an inherited entrypoint and keeps the host environment", () => {
      const host = { CLAUDE_CODE_ENTRYPOINT: "claude-desktop", KEEP: "1" };

      expect(mergeClaudeProcessEnvironment(undefined, host)).toEqual({
        CLAUDE_CODE_ENTRYPOINT: "t3-code",
        KEEP: "1",
      });
      expect(host.CLAUDE_CODE_ENTRYPOINT).toBe("claude-desktop");
    });

    it("lets the provider instance environment set the entrypoint", () => {
      const instance = [{ name: "CLAUDE_CODE_ENTRYPOINT", value: "instance", sensitive: false }];

      expect(
        mergeClaudeProcessEnvironment(instance, { CLAUDE_CODE_ENTRYPOINT: "cli" })
          .CLAUDE_CODE_ENTRYPOINT,
      ).toBe("instance");
    });

    it("points the signed-out hint at the configured Claude home", () => {
      expect(claudeSignedOutMessage({ configDir: undefined, cwd: "/synthetic" })).toContain(
        "run `claude auth login`",
      );
      const configDir = "/synthetic/Claude work's $literal";
      const message = claudeSignedOutMessage({ configDir, cwd: "/synthetic/project" });
      expect(message).toContain(`CLAUDE_CONFIG_DIR set to "${configDir}"`);
      expect(message).not.toContain("CLAUDE_CONFIG_DIR=");
      expect(message).toContain("then start a new thread");
    });

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );

    it.effect("reads the plan tier from the login record and keeps it through a failed read", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-tier-" });
        const record = (tier?: string) =>
          fs.writeFileString(
            path.join(homePath, ".credentials.json"),
            JSON.stringify({
              claudeAiOauth: {
                accessToken: "never-read",
                subscriptionType: "max",
                rateLimitTier: tier,
              },
            }),
          );

        yield* record("default_claude_max_20x");
        expect(yield* readClaudePlanTier({ homePath })).toBe("Max 20x");
        yield* record("default_claude_ai");
        expect(yield* readClaudePlanTier({ homePath })).toBe("Pro");
        // Caught mid-rewrite: the last tier stands, so the plan does not flicker.
        yield* fs.writeFileString(path.join(homePath, ".credentials.json"), '{"claudeAiOa');
        expect(yield* readClaudePlanTier({ homePath })).toBe("Pro");
        yield* record(undefined);
        expect(yield* readClaudePlanTier({ homePath })).toBeUndefined();
      }),
    );
  });
});
