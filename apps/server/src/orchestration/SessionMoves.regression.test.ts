// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import * as Settings from "../serverSettings.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import * as Liveness from "./ThreadBackgroundLiveness.ts";
import * as PlanProgress from "./ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as RepositoryIdentity from "../project/RepositoryIdentityResolver.ts";
import * as Files from "../project/SessionMoveFiles.ts";
import * as Workspaces from "../workspace/SessionWorkspaces.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Workers from "./WorkerControls.ts";
import * as Moves from "./SessionMoves.ts";
import { PeerLinks, PeerRejected, PeerUnavailable, findPeer } from "./PeerLinks.ts";

const encodeUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeUnknown = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const timestamp = "2026-10-22T12:00:00.000Z";
const nativeId = "019b1111-2222-7333-8444-555555555555";
const threadId = ThreadId.make("move-thread");
const selection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
  options: [{ id: "reasoningEffort", value: "max" }],
};
const transcriptName = `sessions/2026/10/22/rollout-2026-10-22T12-00-00-${nativeId}.jsonl`;
const providers = Schema.decodeUnknownSync(Schema.Array(ServerProvider))(
  ["codex", "claudeAgent"].map((driver) => ({
    driver,
    instanceId: driver,
    displayName: driver,
    enabled: true,
    installed: true,
    availability: "available",
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: timestamp,
    models: [
      {
        slug: selection.model,
        name: "Sol",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Effort",
              type: "select",
              options: [{ id: "max", label: "Max" }],
            },
          ],
        },
      },
    ],
  })),
);
const io = <A>(run: () => Promise<A>) => Effect.promise(run);
const makeFixture = (jobs = false) =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      io(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-session-move-"))),
      (directory) => io(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    const peers = ["alpha", "beta", "gamma"].map((id) => ({
      environmentId: id,
      label: id,
      url: "https://" + id + ".test",
      token: id,
    }));
    const handlers = new Map<
      string,
      (from: string, input: unknown) => Effect.Effect<unknown, { readonly message: string }>
    >();
    const offline = new Set<string>();
    let loseCommitResponse = false;
    let wrongNativeId = false;
    let chunkGate:
      | { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void>; afterChunks?: number }
      | undefined;
    let chunksSeen = 0;
    let checkoutGate:
      | { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
      | undefined;
    const starts: Array<{ environment: string; cursor: unknown }> = [];
    const environments = [];
    for (const id of ["alpha", "beta", "gamma"]) {
      const cwd = NodePath.join(root, id);
      const home = NodePath.join(root, id + "-provider");
      yield* io(async () => {
        await NodeFSP.mkdir(home);
        if (id === "alpha") {
          await NodeFSP.mkdir(cwd);
          await Files.git(cwd, ["init", "-q"]);
          await Files.git(cwd, ["config", "user.email", "move@test.local"]);
          await Files.git(cwd, ["config", "user.name", "Move Test"]);
          await NodeFSP.writeFile(NodePath.join(cwd, "code.txt"), "base\n");
          await Files.git(cwd, ["add", "."]);
          await Files.git(cwd, ["commit", "-qm", "base"]);
        } else await Files.git(root, ["clone", "-q", NodePath.join(root, "alpha"), cwd]);
        await Files.git(cwd, ["config", "core.longpaths", "true"]);
        await Files.git(cwd, ["config", "core.autocrlf", "false"]);
      });
      const infrastructure = Layer.mergeAll(
        OrchestrationEngineLive.pipe(
          Layer.provide(OrchestrationProjectionSnapshotQueryLive),
          Layer.provide(OrchestrationProjectionPipelineLive),
        ),
        OrchestrationProjectionSnapshotQueryLive,
        ProviderSessionDirectoryLive.pipe(Layer.provide(ProviderSessionRuntime.layer)),
      ).pipe(
        Layer.provideMerge(Liveness.layer),
        Layer.provide(PlanProgress.layer),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentity.layer),
        Layer.provideMerge(
          Workspaces.layer.pipe(
            Layer.provide(
              Layer.effect(
                Git.GitVcsDriver,
                Effect.gen(function* () {
                  const git = yield* Git.GitVcsDriver;
                  return Git.GitVcsDriver.of({
                    ...git,
                    createWorktree: (input, options) =>
                      Effect.gen(function* () {
                        if (id === "beta" && checkoutGate) {
                          yield* Deferred.succeed(checkoutGate.entered, undefined);
                          yield* Deferred.await(checkoutGate.release);
                        }
                        return yield* git.createWorktree(input, options);
                      }),
                  });
                }),
              ).pipe(Layer.provide(Git.layer)),
            ),
            Layer.provide(VcsProcess.layer),
            Layer.provide(ProcessRunner.layer),
          ),
        ),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(
          Settings.layerTest({
            ...(jobs ? { agentWorkRoot: NodePath.join(root, id + "-jobs") } : {}),
            providers: { codex: { homePath: home }, claudeAgent: { homePath: home } },
          }),
        ),
        Layer.provideMerge(ServerConfig.layerTest(cwd, { prefix: "t3-native-move-test-" })),
        Layer.provideMerge(NodeServices.layer),
      );
      const peerLayer = Layer.succeed(
        PeerLinks,
        PeerLinks.of({
          list: Effect.succeed(peers.filter((entry) => entry.environmentId !== id)),
          localEnvironment: Effect.succeed({ environmentId: id, label: id }),
          resolve: (name) =>
            Effect.succeed(
              findPeer(
                peers.filter((entry) => entry.environmentId !== id),
                name,
              ),
            ),
          call: (target, input) => {
            const handler = handlers.get(target);
            if (!handler || offline.has(target))
              return Effect.fail(
                new PeerUnavailable({ environmentId: target, message: "offline" }),
              );
            const gate =
              chunkGate &&
              (input as { op?: string }).op === "chunk" &&
              ++chunksSeen > (chunkGate.afterChunks ?? 1)
                ? chunkGate
                : undefined;
            return (
              gate
                ? Deferred.succeed(gate.entered, undefined).pipe(
                    Effect.andThen(Deferred.await(gate.release)),
                  )
                : Effect.void
            ).pipe(
              Effect.andThen(handler(id, structuredClone(input))),
              Effect.mapError((error) => new PeerRejected({ message: error.message })),
              Effect.flatMap((result) => {
                if (loseCommitResponse && (input as { op?: string }).op === "commit") {
                  loseCommitResponse = false;
                  return Effect.fail(
                    new PeerUnavailable({ environmentId: target, message: "lost commit response" }),
                  );
                }
                return Effect.succeed(structuredClone(result));
              }),
            );
          },
        }),
      );
      const provider = Layer.mock(ProviderService)({
        stopSession: () => Effect.void,
        startSession: (id, input) =>
          Effect.sync(() => {
            starts.push({ environment: id, cursor: input.resumeCursor });
            return {
              threadId: id,
              provider: input.provider!,
              providerInstanceId: input.providerInstanceId!,
              runtimeMode: input.runtimeMode,
              status: "ready" as const,
              cwd: input.cwd!,
              resumeCursor: wrongNativeId
                ? { threadId: "different-native-session" }
                : input.resumeCursor,
              createdAt: timestamp,
              updatedAt: timestamp,
            };
          }),
      });
      const layer = Moves.layer.pipe(
        Layer.provideMerge(Workers.layer),
        Layer.provideMerge(infrastructure),
        Layer.provideMerge(peerLayer),
        Layer.provideMerge(provider),
        Layer.provideMerge(
          Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
        ),
      );
      const context = yield* Layer.build(layer);
      const [moves, engine, snapshots, directory, workers, sql, config] = yield* Effect.all([
        Moves.SessionMoves,
        OrchestrationEngineService,
        ProjectionSnapshotQuery,
        ProviderSessionDirectory,
        Workers.WorkerControls,
        SqlClient.SqlClient,
        ServerConfig,
      ]).pipe(Effect.provide(context));
      handlers.set(id, (from, input) =>
        (input as { _tag: string })._tag === "sessionMove"
          ? moves.receive(from, input)
          : workers.receive(from, input),
      );
      const projectId = ProjectId.make(id + "-project");
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make(id + "-project"),
        projectId,
        title: "Same project",
        workspaceRoot: cwd,
        createdAt: timestamp,
      });
      environments.push({
        id,
        cwd,
        home,
        context,
        moves,
        engine,
        snapshots,
        directory,
        workers,
        sql,
        config,
        projectId,
      });
    }
    const [alpha, beta, gamma] = environments as [
      (typeof environments)[number],
      (typeof environments)[number],
      (typeof environments)[number],
    ];
    const bytes = Buffer.from(
      '{"type":"session_meta","id":"' +
        nativeId +
        '"}\n{"type":"compacted","context":"all intermediate context"}\n' +
        "x".repeat(Files.MOVE_CHUNK_BYTES + 33),
    );
    yield* io(async () => {
      const filename = NodePath.join(alpha.home, transcriptName);
      await NodeFSP.mkdir(NodePath.dirname(filename), { recursive: true });
      await NodeFSP.writeFile(filename, bytes);
      await NodeFSP.writeFile(NodePath.join(alpha.cwd, "code.txt"), "staged\n");
      await Files.git(alpha.cwd, ["add", "code.txt"]);
      await NodeFSP.writeFile(NodePath.join(alpha.cwd, "code.txt"), "working\n");
    });
    yield* alpha.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-source"),
      threadId,
      projectId: alpha.projectId,
      title: "Preserve this conversation",
      modelSelection: selection,
      runtimeMode: "full-access",
      interactionMode: "plan",
      branch: "main",
      worktreePath: null,
      historyImport: true,
      createdAt: timestamp,
    });
    yield* alpha.engine.dispatch({
      type: "thread.history.import",
      commandId: CommandId.make("history-source"),
      threadId,
      messages: [
        {
          messageId: MessageId.make("user-message"),
          role: "user",
          text: "Keep all the context",
          createdAt: timestamp,
        },
        {
          messageId: MessageId.make("assistant-message"),
          role: "assistant",
          text: "blue heron 74",
          createdAt: "2026-10-22T12:00:01.000Z",
        },
      ],
    });
    yield* alpha.directory.upsert({
      threadId,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: selection.instanceId,
      runtimeMode: "full-access",
      status: "stopped",
      resumeCursor: { threadId: nativeId },
      runtimePayload: { cwd: alpha.cwd },
    });
    const input = {
      requestId: CommandId.make("native-move-1"),
      threadId,
      environment: "beta",
      projectId: beta.projectId,
    };
    const unlockSource = () => alpha.moves.status({ requestId: input.requestId, cancel: true });
    return {
      alpha,
      beta,
      gamma,
      input,
      bytes,
      starts,
      offline,
      unlockSource,
      loseCommit: () => {
        loseCommitResponse = true;
      },
      wrongResume: () => {
        wrongNativeId = true;
      },
      restoreResume: () => {
        wrongNativeId = false;
      },
      holdChunk: (value: NonNullable<typeof chunkGate>) => {
        chunkGate = value;
      },
      holdCheckout: (value: NonNullable<typeof checkoutGate>) => {
        checkoutGate = value;
      },
    };
  });

for (const jobs of [false, true])
  it.effect(`R2 cancelled partial move retry jobs=${jobs}`, () =>
    Effect.gen(function* () {
      const { alpha, beta, input, holdChunk } = yield* makeFixture(jobs);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      holdChunk({ entered, release });
      yield* alpha.moves.request(input);
      const draining = yield* alpha.moves.drain().pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      expect((yield* alpha.moves.status({ requestId: input.requestId, cancel: true })).state).toBe(
        "cancelled",
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(draining);
      expect(yield* beta.sql`SELECT 1 FROM session_workspaces WHERE active = 1`).toHaveLength(0);
      const workspaces = yield* Workspaces.SessionWorkspaces.pipe(Effect.provide(beta.context));
      const oldStage = yield* workspaces.transferDirectory(threadId, input.requestId);
      const manifest = decodeUnknown(
        (yield* beta.sql<{
          manifest_json: string;
        }>`SELECT manifest_json FROM custom_session_moves WHERE id = ${input.requestId}`)[0]!
          .manifest_json,
      ) as { sourceEnvironmentId: string; input: typeof input; files: Files.MoveFile[] };
      const first = manifest.files[0]!;
      const retained = oldStage ? NodePath.join(oldStage, first.kind, first.name) : null;
      const before = retained ? yield* io(() => Files.digestFile(retained)) : null;
      if (jobs) {
        const requestId = CommandId.make("foreign-owner-retry");
        const foreign = yield* beta.moves
          .receive("gamma", {
            _tag: "sessionMove",
            op: "begin",
            requestId,
            manifest: {
              ...manifest,
              sourceEnvironmentId: "gamma",
              input: { ...manifest.input, requestId },
            },
          })
          .pipe(Effect.result);
        expect(foreign._tag).toBe("Failure");
        expect(
          yield* beta.sql`SELECT 1 FROM custom_session_moves WHERE id = ${requestId}`,
        ).toHaveLength(0);
        expect(yield* beta.sql`SELECT 1 FROM session_workspaces`).toHaveLength(1);
      }
      const retry = { ...input, requestId: CommandId.make("retry-partial-copy") };
      yield* alpha.moves.request(retry);
      yield* alpha.moves.drain();
      const status = yield* alpha.moves.status({ requestId: retry.requestId });
      expect(status, encodeUnknown(status)).toMatchObject({ state: "complete", error: null });
      if (retained) expect(yield* io(() => Files.digestFile(retained))).toBe(before);
    }).pipe(Effect.scoped),
  );

it.effect("R4 rejected creation must not consume an incoming move reservation", () =>
  Effect.gen(function* () {
    const { alpha, beta, input, holdChunk } = yield* makeFixture(true);
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    holdChunk({ entered, release, afterChunks: 0 });
    yield* alpha.moves.request(input);
    const draining = yield* alpha.moves.drain().pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const created = yield* beta.engine
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make("stale-create-retry"),
        threadId,
        projectId: beta.projectId,
        title: "creation retry",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "plan",
        branch: null,
        worktreePath: null,
        createdAt: timestamp,
      })
      .pipe(Effect.result);
    expect(created._tag).toBe("Failure");
    const active = yield* beta.sql`SELECT reservation_id FROM session_workspaces WHERE active = 1`;
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(draining);
    const status = yield* alpha.moves.status({ requestId: input.requestId });
    expect(active, encodeUnknown({ active, status })).toHaveLength(0);
    expect(status).toMatchObject({ state: "complete", error: null });
  }).pipe(Effect.scoped),
);

it.effect("R4 a create reservation wins before checkout without blocking the command queue", () =>
  Effect.gen(function* () {
    const { alpha, beta, input, holdCheckout } = yield* makeFixture(true);
    yield* alpha.moves.request(input);
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    holdCheckout({ entered, release });
    const creating = yield* beta.engine
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make("winning-create"),
        threadId,
        projectId: beta.projectId,
        title: "creation",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "plan",
        branch: null,
        worktreePath: null,
        createdAt: timestamp,
      })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    // A second independent create uses the serialized engine while checkout waits.
    yield* beta.engine.dispatch({
      type: "project.meta.update",
      commandId: CommandId.make("queue-control"),
      projectId: beta.projectId,
      title: "queue remains responsive",
    });
    yield* alpha.moves.drain();
    expect((yield* alpha.moves.status({ requestId: input.requestId })).error).toContain(
      "not a parked",
    );
    expect(
      yield* beta.sql`SELECT 1 FROM custom_session_moves WHERE id = ${input.requestId}`,
    ).toHaveLength(0);
    expect(
      (yield* beta.sql`SELECT reservation_id FROM session_workspaces`)[0]!.reservation_id,
    ).toBe("new:" + threadId);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(creating);
    expect(Option.isSome(yield* beta.snapshots.getThreadDetailById(threadId))).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect("R2 retries a cancelled installed copy while preserving its old workspace", () =>
  Effect.gen(function* () {
    const { alpha, beta, input, wrongResume, restoreResume } = yield* makeFixture(true);
    yield* alpha.moves.request(input);
    wrongResume();
    yield* alpha.moves.drain();
    yield* alpha.moves.status({ requestId: input.requestId, cancel: true });
    const workspace = yield* Workspaces.SessionWorkspaces.pipe(Effect.provide(beta.context));
    const old = (yield* workspace.get(threadId))!;
    yield* io(() =>
      NodeFSP.writeFile(NodePath.join(old.workspaceDirectory, "keep.txt"), "cancelled source"),
    );
    restoreResume();
    const retry = { ...input, requestId: CommandId.make("retry-installed-copy") };
    yield* alpha.moves.request(retry);
    yield* alpha.moves.drain();
    expect(yield* alpha.moves.status({ requestId: retry.requestId })).toMatchObject({
      state: "complete",
      error: null,
    });
    expect(
      yield* io(() =>
        NodeFSP.readFile(NodePath.join(old.root, "previous", retry.requestId, "keep.txt"), "utf8"),
      ),
    ).toBe("cancelled source");
  }).pipe(Effect.scoped),
);
