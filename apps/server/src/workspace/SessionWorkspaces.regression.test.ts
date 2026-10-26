import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ProcessRunner from "../processRunner.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as Workspaces from "./SessionWorkspaces.ts";

const dependencies = Layer.mergeAll(Git.layer, ProcessRunner.layer, Settings.layerTest()).pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "session-jobs-" })),
  Layer.provideMerge(NodeServices.layer),
);
const testLayer = Layer.mergeAll(OrchestrationLayerLive, Workspaces.layer).pipe(
  Layer.provideMerge(Workspaces.layer),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(dependencies),
);
const fixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git.GitVcsDriver;
  const settings = yield* Settings.ServerSettingsService;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "workspace-test-" });
  const primary = path.join(root, "primary");
  const jobs = path.join(root, "jobs");
  yield* fs.makeDirectory(primary);
  yield* fs.makeDirectory(jobs);
  const run = (args: string[], cwd = primary) => git.execute({ operation: "test", cwd, args });
  yield* run(["init", "--initial-branch=main"]);
  yield* run(["config", "user.name", "Workspace test"]);
  yield* run(["config", "user.email", "workspace@example.invalid"]);
  yield* fs.writeFileString(path.join(primary, "source.txt"), "original\n");
  yield* run(["add", "."]);
  yield* run(["commit", "-m", "initial"]);
  yield* settings.updateSettings({ agentWorkRoot: jobs, workspaceLifecycleCommand: null });
  return { fs, path, primary, jobs, root, run, settings };
});

it.layer(testLayer)("independent review", (it) => {
  for (const nested of [false, true]) {
    it.effect(
      `R1 snapshot create isolates junctions and excludes cycles with nested root=${nested}`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          const source = f.path.join(f.root, "ordinary");
          const src = f.path.join(source, "src");
          const jobs = nested ? f.path.join(source, "jobs") : f.jobs;
          const generated = f.path.join(jobs, "previous-job");
          yield* f.fs.makeDirectory(src, { recursive: true });
          yield* f.fs.makeDirectory(generated, { recursive: true });
          yield* f.fs.makeDirectory(f.path.join(src, ".git"));
          yield* f.fs.writeFileString(f.path.join(src, "input.txt"), "persistent input");
          yield* f.fs.writeFileString(f.path.join(src, ".git", "private-config"), "metadata");
          yield* f.fs.writeFileString(f.path.join(generated, "output.txt"), "other job output");
          for (const [link, target] of [
            ["alias", src],
            ["src/back", source],
            ["src/self", src],
            ["cycle-a", f.path.join(source, "cycle-b")],
            ["cycle-b", f.path.join(source, "cycle-a")],
            ["work-alias", jobs],
            ["work-child-alias", generated],
            ["metadata-alias", f.path.join(src, ".git")],
          ]) {
            yield* Effect.promise(() =>
              NodeFSP.symlink(target!, f.path.join(source, link!), "junction"),
            );
          }
          yield* f.settings.updateSettings({ agentWorkRoot: jobs });
          const engine = yield* OrchestrationEngineService;
          const id = "snapshot-links-" + nested;
          const projectId = ProjectId.make(id);
          const threadId = ThreadId.make(id);
          yield* engine.dispatch({
            type: "project.create",
            commandId: CommandId.make(id + "-project"),
            projectId,
            title: id,
            workspaceRoot: source,
            createdAt: "2026-10-24T00:00:00.000Z",
          });
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(id + "-create"),
            threadId,
            projectId,
            title: id,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-10-24T00:00:00.000Z",
          });
          const service = yield* Workspaces.SessionWorkspaces;
          const job = (yield* service.verify(threadId))!;
          expect(
            Option.getOrThrow(yield* (yield* ProjectionSnapshotQuery).getThreadDetailById(threadId))
              .worktreePath,
          ).toBe(job.workspaceDirectory);
          for (const name of ["src", "alias"]) {
            const directory = f.path.join(job.workspaceDirectory, name);
            const stat = yield* Effect.promise(() => NodeFSP.lstat(directory));
            expect(stat.isSymbolicLink()).toBe(false);
            expect(stat.isDirectory()).toBe(true);
            expect(yield* f.fs.readFileString(f.path.join(directory, "input.txt"))).toBe(
              "persistent input",
            );
            for (const excluded of ["back", "self", ".git"])
              expect(yield* f.fs.exists(f.path.join(directory, excluded))).toBe(false);
          }
          for (const excluded of [
            "jobs",
            "work-alias",
            "work-child-alias",
            "metadata-alias",
            "cycle-a",
            "cycle-b",
          ])
            expect(yield* f.fs.exists(f.path.join(job.workspaceDirectory, excluded))).toBe(false);
          yield* f.fs.writeFileString(
            f.path.join(job.workspaceDirectory, "alias", "input.txt"),
            "job alias edit",
          );
          expect(
            yield* f.fs.readFileString(f.path.join(job.workspaceDirectory, "src", "input.txt")),
          ).toBe("persistent input");
          yield* f.fs.writeFileString(
            f.path.join(job.workspaceDirectory, "src", "input.txt"),
            "job source edit",
          );
          expect(yield* f.fs.readFileString(f.path.join(src, "input.txt"))).toBe(
            "persistent input",
          );
          expect(yield* f.fs.readFileString(f.path.join(generated, "output.txt"))).toBe(
            "other job output",
          );
          expect(yield* f.fs.readFileString(f.path.join(src, ".git", "private-config"))).toBe(
            "metadata",
          );
          expect(
            (yield* Effect.promise(() =>
              NodeFSP.lstat(f.path.join(source, "alias")),
            )).isSymbolicLink(),
          ).toBe(true);
        }),
    );
  }
  it.effect("R1 snapshot retry preserves its reservation, receipt and interrupted staging", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const source = f.path.join(f.root, "ordinary-retry");
      const outside = f.path.join(f.root, "external-input");
      yield* f.fs.makeDirectory(source);
      yield* f.fs.makeDirectory(outside);
      yield* f.fs.writeFileString(f.path.join(source, "input.txt"), "persistent input");
      yield* f.fs.writeFileString(f.path.join(outside, "private.txt"), "external input");
      const link = f.path.join(source, "external");
      yield* Effect.promise(() => NodeFSP.symlink(outside, link, "junction"));
      const service = yield* Workspaces.SessionWorkspaces;
      const input = { threadId: ThreadId.make("snapshot-retry"), sourceDirectory: source };
      const failed = yield* service.prepare(input).pipe(Effect.flip);
      expect(failed.message).toContain("links outside");
      const reserved = (yield* service.get(input.threadId))!;
      const staged = f.path.join(reserved.tmpDirectory, "source-snapshot");
      yield* f.fs.writeFileString(f.path.join(staged, "partial.txt"), "interrupted copy evidence");
      yield* Effect.promise(() => NodeFSP.unlink(link));
      const job = (yield* service.prepare(input))!;
      expect(job).toEqual(reserved);
      const retained = (yield* f.fs.readDirectory(job.tmpDirectory)).filter((name) =>
        name.startsWith("source-snapshot-incomplete-"),
      );
      expect(retained).toHaveLength(1);
      expect(
        yield* f.fs.readFileString(f.path.join(job.tmpDirectory, retained[0]!, "partial.txt")),
      ).toBe("interrupted copy evidence");
      expect(yield* f.fs.exists(f.path.join(job.workspaceDirectory, "external"))).toBe(false);
      expect(yield* f.fs.readFileString(f.path.join(outside, "private.txt"))).toBe(
        "external input",
      );
      const receipt = yield* f.fs.readFileString(f.path.join(job.root, "source-snapshot.json"));
      yield* f.fs.writeFileString(
        f.path.join(job.workspaceDirectory, "input.txt"),
        "retained job edit",
      );
      yield* f.fs.writeFileString(f.path.join(source, "input.txt"), "new original edit");
      yield* f.settings.updateSettings({ agentWorkRoot: f.path.join(f.root, "changed-root") });
      const resumed = yield* Effect.gen(function* () {
        return yield* (yield* Workspaces.SessionWorkspaces).prepare(input);
      }).pipe(Effect.provide(Workspaces.layer));
      expect(resumed).toEqual(job);
      expect(yield* f.fs.readFileString(f.path.join(job.root, "source-snapshot.json"))).toBe(
        receipt,
      );
      expect(yield* f.fs.readFileString(f.path.join(job.workspaceDirectory, "input.txt"))).toBe(
        "retained job edit",
      );
    }),
  );
  it.effect("R2 refuses a foreign job root without a durable cancelled reservation", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const service = yield* Workspaces.SessionWorkspaces;
      const threadId = ThreadId.make("foreign-root");
      const cwd = (yield* service.movePath(threadId, "incoming"))!;
      const root = f.path.dirname(cwd);
      yield* f.fs.makeDirectory(root);
      yield* f.fs.writeFileString(f.path.join(root, "unique.txt"), "foreign source");
      const revision = (yield* f.run(["rev-parse", "HEAD"])).stdout.trim();
      const result = yield* service
        .reserveMove({
          threadId,
          requestId: "incoming",
          sourceDirectory: f.primary,
          cwd,
          revision,
          branch: "incoming",
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(yield* service.transferDirectory(threadId, "incoming")).toBeNull();
      expect(yield* f.fs.readFileString(f.path.join(root, "unique.txt"))).toBe("foreign source");
      expect(yield* f.fs.exists(cwd)).toBe(false);
    }),
  );
  for (const enabled of [false, true])
    for (const kind of ["nongit", "emptygit"] as const) {
      it.effect(
        `R1 root ${enabled ? "enabled" : "disabled"} preserves supported ${kind} project creation`,
        () =>
          Effect.gen(function* () {
            const f = yield* fixture();
            if (!enabled) yield* f.settings.updateSettings({ agentWorkRoot: "" });
            const engine = yield* OrchestrationEngineService;
            const source = f.path.join(f.root, kind);
            yield* f.fs.makeDirectory(source);
            if (kind === "emptygit") yield* f.run(["init", "--initial-branch=main"], source);
            yield* f.fs.writeFileString(f.path.join(source, "input.txt"), "persistent input");
            const originalConfig =
              kind === "emptygit"
                ? yield* f.fs.readFileString(f.path.join(source, ".git", "config"))
                : null;
            const caseId = `${kind}-${enabled}`;
            const projectId = ProjectId.make(caseId);
            yield* engine.dispatch({
              type: "project.create",
              commandId: CommandId.make(caseId + "-project"),
              projectId,
              title: kind,
              workspaceRoot: source,
              createdAt: "2026-10-24T00:00:00.000Z",
            });
            const result = yield* engine
              .dispatch({
                type: "thread.create",
                commandId: CommandId.make(caseId + "-thread"),
                threadId: ThreadId.make(caseId),
                projectId,
                title: kind,
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: "gpt-6-astra",
                },
                runtimeMode: "approval-required",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt: "2026-10-24T00:00:00.000Z",
              })
              .pipe(Effect.result);
            expect(result._tag, String(result)).toBe("Success");
            const workspace = yield* Workspaces.SessionWorkspaces;
            const job = yield* workspace.verify(caseId);
            const thread = Option.getOrThrow(
              yield* (yield* ProjectionSnapshotQuery).getThreadDetailById(ThreadId.make(caseId)),
            );
            if (!enabled) {
              expect(job).toBeNull();
              expect(thread.worktreePath).toBeNull();
              expect(yield* f.fs.readDirectory(f.jobs)).toEqual([]);
            } else {
              expect(thread.worktreePath).toBe(job!.workspaceDirectory);
              expect(job!.sourceDirectory).toBe(source);
              expect(
                yield* f.fs.readFileString(f.path.join(job!.workspaceDirectory, "input.txt")),
              ).toBe("persistent input");
              yield* f.fs.writeFileString(
                f.path.join(job!.workspaceDirectory, "input.txt"),
                "agent output",
              );
              expect(yield* f.fs.readFileString(f.path.join(source, "input.txt"))).toBe(
                "persistent input",
              );
              yield* f.fs.writeFileString(f.path.join(source, "input.txt"), "later original edit");
              yield* f.settings.updateSettings({
                agentWorkRoot: f.path.join(f.root, "different-root"),
              });
              const resumed = yield* Effect.gen(function* () {
                return yield* (yield* Workspaces.SessionWorkspaces).prepare({
                  threadId: ThreadId.make(caseId),
                  sourceDirectory: source,
                });
              }).pipe(Effect.provide(Workspaces.layer));
              expect(resumed).toEqual(job);
              expect(
                yield* f.fs.readFileString(f.path.join(job!.workspaceDirectory, "input.txt")),
              ).toBe("agent output");
            }
            if (kind === "nongit") {
              expect(yield* f.fs.exists(f.path.join(source, ".git"))).toBe(false);
              if (job)
                expect(yield* f.fs.exists(f.path.join(job.workspaceDirectory, ".git"))).toBe(false);
            } else {
              expect(yield* f.fs.readFileString(f.path.join(source, ".git", "config"))).toBe(
                originalConfig,
              );
              for (const cwd of [source, ...(job ? [job.workspaceDirectory] : [])]) {
                const head = yield* (yield* Git.GitVcsDriver).execute({
                  operation: "test",
                  cwd,
                  args: ["rev-parse", "--verify", "HEAD"],
                  allowNonZeroExit: true,
                });
                expect(head.exitCode).not.toBe(0);
              }
            }
          }),
      );
    }
});
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
