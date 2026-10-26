// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { BeforeNativeFork } from "../NativeFork.ts";
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";
import wire from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const peerPath = NodePath.join(
  import.meta.dirname,
  "../testFixtures",
  `codexCollabMockPeer.${HostProcessPlatform.defaultValue() === "win32" ? "cmd" : "sh"}`,
);

it.effect(
  "launches the actual Codex fork child in its job and gates native cloning on the receipt",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        directory: NodeOS.tmpdir(),
        prefix: "fork-job-",
      });
      const source = NodePath.join(root, "source");
      const child = NodePath.join(root, "child");
      const tmp = NodePath.join(child, "tmp");
      yield* fs.makeDirectory(source);
      yield* fs.makeDirectory(tmp, { recursive: true });
      const script = NodePath.join(root, "script.json");
      yield* fs.writeFileString(
        script,
        encode({ rootThreadId: wire.rootThreadId, notifications: [], recordLaunch: true }),
      );
      const parentEnv = { ...process.env };
      const parentCwd = process.cwd();
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("fork-job-source"),
        binaryPath: peerPath,
        cwd: source,
        runtimeMode: "approval-required",
        environment: {
          ...process.env,
          T3_CODEX_COLLAB_SCRIPT: script,
          T3_WORKSPACE_JOB_ID: "source-job",
          TMP: source,
          CODEX_HOME: "preserved-auth-home",
        },
      });
      const original = yield* runtime.start();
      const target = {
        cwd: child,
        workspaceEnvironment: { T3_WORKSPACE_JOB_ID: "child-job", TMP: tmp },
      };
      const rejected = yield* runtime.forkConversation!(target).pipe(
        Effect.provideService(BeforeNativeFork, Effect.fail("Receipt unavailable")),
        Effect.result,
      );
      expect(rejected._tag).toBe("Failure");
      expect(yield* fs.exists(`${script}.requests`)).toBe(false);
      let checkpoints = 0;
      const fork = yield* runtime.forkConversation!(target).pipe(
        Effect.provideService(
          BeforeNativeFork,
          Effect.sync(() => {
            // Initialization has completed, but the child has not received thread/fork.
            expect(NodeFS.existsSync(`${script}.requests`)).toBe(false);
            expect(
              NodeFS.readFileSync(`${script}.launches`, "utf8").trim().split("\n"),
            ).toHaveLength(3);
            checkpoints++;
          }),
        ),
      );
      expect(checkpoints).toBe(1);
      expect(fork).not.toEqual(original.resumeCursor);
      expect(decode((yield* fs.readFileString(`${script}.requests`)).trim())).toEqual({
        method: "thread/fork",
        params: { threadId: wire.rootThreadId, cwd: child },
      });
      const launches = (yield* fs.readFileString(`${script}.launches`))
        .trim()
        .split("\n")
        .map((line) => decode(line));
      expect(launches).toEqual([
        { cwd: source, tmp: source, job: "source-job", authHome: "preserved-auth-home" },
        ...[1, 2].map(() => ({
          cwd: child,
          tmp,
          job: "child-job",
          authHome: "preserved-auth-home",
        })),
      ]);
      expect((yield* runtime.sendTurn({ input: "Source remains usable" })).turnId).toBeDefined();
      expect(process.env).toEqual(parentEnv);
      expect(process.cwd()).toBe(parentCwd);
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
