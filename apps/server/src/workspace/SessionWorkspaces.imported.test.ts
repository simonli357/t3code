import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SessionWorkspaces from "./SessionWorkspaces.ts";

const dependencies = Layer.mergeAll(
  Git.layer,
  ProcessRunner.layer,
  ServerSettings.layerTest({ agentWorkRoot: "/jobs", workspaceLifecycleCommand: null }),
).pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "imported-workspace-" })),
  Layer.provideMerge(NodeServices.layer),
);

const testLayer = SessionWorkspaces.layer.pipe(Layer.provideMerge(dependencies));

const encodeJob = Schema.encodeSync(Schema.fromJsonString(SessionWorkspaces.SessionWorkspace));

/**
 * A ready job the custom fork leaves in `session_workspaces`: a linked worktree of a persistent
 * primary, with no `sourceKind` because that field arrived after the imported rows were written.
 */
const importedJob = (input: {
  readonly jobs: string;
  readonly primary: string;
  readonly threadId: string;
}) => {
  const root = `${input.jobs}/job-1`;
  return {
    version: 1 as const,
    jobId: "job-1",
    threadId: input.threadId,
    reservationId: "reservation-1",
    root,
    sourceDirectory: input.primary,
    workspaceDirectory: `${root}/repo`,
    tmpDirectory: `${root}/tmp`,
    buildDirectory: `${root}/build`,
    cacheDirectory: `${root}/cache`,
    downloadsDirectory: `${root}/downloads`,
    outputsDirectory: `${root}/outputs`,
    evidenceDirectory: `${root}/evidence`,
    revision: "HEAD",
    branch: "session-1",
    lifecycleCommand: null,
  };
};

describe("imported session workspaces", () => {
  it.effect("resolves, verifies and hands a V1 job to a forked thread", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* Git.GitVcsDriver;
      const sql = yield* SqlClient.SqlClient;
      const workspaces = yield* SessionWorkspaces.SessionWorkspaces;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "imported-workspace-" });
      const primary = path.join(root, "primary");
      const jobs = path.join(root, "jobs");
      yield* fs.makeDirectory(primary);
      yield* fs.makeDirectory(jobs);
      const run = (args: string[], cwd = primary) =>
        git.execute({ operation: "imported-workspace-test", cwd, args });
      yield* run(["init", "--initial-branch=main"]);
      yield* run(["config", "user.name", "Import test"]);
      yield* run(["config", "user.email", "import@example.invalid"]);
      yield* fs.writeFileString(path.join(primary, "source.txt"), "original\n");
      yield* run(["add", "."]);
      yield* run(["commit", "-m", "initial"]);
      const job = importedJob({ jobs, primary, threadId: "worker-1" });
      for (const directory of [
        job.tmpDirectory,
        job.buildDirectory,
        job.cacheDirectory,
        job.downloadsDirectory,
        job.outputsDirectory,
        job.evidenceDirectory,
      ])
        yield* fs.makeDirectory(directory, { recursive: true });
      yield* run(["worktree", "add", job.workspaceDirectory, "-b", job.branch]);

      yield* sql`INSERT INTO session_workspaces
        (reservation_id, thread_id, binding_json, state, active, setup_complete)
        VALUES (${job.reservationId}, ${job.threadId}, ${encodeJob(job)}, 'ready', 1, 0)`;

      assert.deepEqual(yield* workspaces.get("worker-1"), job);
      assert.deepEqual(yield* workspaces.list(), [job]);
      assert.isTrue(yield* workspaces.needsSetup("worker-1"));
      yield* workspaces.completeSetup("worker-1");
      assert.isFalse(yield* workspaces.needsSetup("worker-1"));
      assert.deepEqual(yield* workspaces.verify("worker-1"), job);

      assert.deepEqual(yield* workspaces.inherit("worker-1", "fork-1"), job);
      assert.deepEqual(yield* workspaces.get("fork-1"), job);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});
