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
import * as Workers from "./WorkerControls.ts";
import * as Moves from "./SessionMoves.ts";
import { PeerLinks, PeerRejected, PeerUnavailable, findPeer } from "./PeerLinks.ts";

const encodeUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const timestamp = "2026-10-22T12:00:00.000Z";
const nativeId = "019b1111-2222-7333-8444-555555555555";
const threadId = ThreadId.make("move-thread");
const selection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
  options: [{ id: "reasoningEffort", value: "max" }],
};
const transcriptName = `sessions/2026/10/22/rollout-2026-10-22T12-00-00-${nativeId}.jsonl`;
const providers = Schema.decodeUnknownSync(Schema.Array(ServerProvider))([
  ...["codex", "claudeAgent"].map((driver) => ({
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
]);
const io = <A>(run: () => Promise<A>) => Effect.promise(run);
const fixture = Effect.gen(function* () {
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
  let chunkGate: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined;
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
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(
        Settings.layerTest({
          providers: { codex: { homePath: home }, claudeAgent: { homePath: home } },
        }),
      ),
      Layer.provideMerge(ServerConfig.layerTest(cwd, { prefix: "t3-native-move-test-" })),
      Layer.provideMerge(NodeServices.layer),
    );
    const peerLayer = Layer.succeed(
      PeerLinks,
      PeerLinks.of({
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
            return Effect.fail(new PeerUnavailable({ environmentId: target, message: "offline" }));
          const gate =
            chunkGate && (input as { op?: string }).op === "chunk" ? chunkGate : undefined;
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
      Layer.provideMerge(Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed(providers) })),
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
  };
});

it.effect(
  "moves the exact native session, complete T3 history, settings and workspace with one writable owner",
  () =>
    Effect.gen(function* () {
      const { alpha, beta, input, bytes } = yield* fixture;
      expect((yield* alpha.moves.request(input, threadId)).state).toBe("queued");
      yield* alpha.moves.drain();
      expect(yield* alpha.moves.status({ requestId: input.requestId })).toMatchObject({
        state: "complete",
        error: null,
        targetThreadId: threadId,
      });
      const detail = Option.getOrThrow(yield* beta.snapshots.getThreadDetailById(threadId));
      expect(detail.messages.map((entry) => entry.text)).toEqual([
        "Keep all the context",
        "blue heron 74",
      ]);
      expect(detail).toMatchObject({
        projectId: beta.projectId,
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "plan",
      });
      expect(yield* io(() => NodeFSP.readFile(NodePath.join(beta.home, transcriptName)))).toEqual(
        bytes,
      );
      expect(
        yield* io(() => NodeFSP.readFile(NodePath.join(detail.worktreePath!, "code.txt"), "utf8")),
      ).toBe("working\n");
      expect(yield* io(() => Files.git(detail.worktreePath!, ["show", ":code.txt"]))).toBe(
        "staged\n",
      );
      expect(yield* io(() => Files.git(beta.cwd, ["status", "--porcelain"]))).toBe("");
      expect(
        (yield* alpha.sql`SELECT archived_at FROM projection_threads WHERE thread_id = ${threadId}`)[0]!
          .archived_at,
      ).not.toBeNull();
      const command = {
        type: "thread.meta.update" as const,
        commandId: CommandId.make("after-move-source"),
        threadId,
        title: "should fail",
      };
      expect((yield* alpha.engine.dispatch(command).pipe(Effect.flip)).message).toContain("moved");
      yield* beta.engine.dispatch({
        ...command,
        commandId: CommandId.make("after-move-target"),
        title: "Continued here",
      });
      // Retries use receipts, and imported history never enters the reactor stream.
      expect((yield* alpha.moves.request(input)).state).toBe("complete");
      expect(
        (yield* beta.sql`SELECT COUNT(*) AS n FROM orchestration_events WHERE stream_id = ${threadId} AND event_type = 'thread.created'`)[0]!
          .n,
      ).toBe(1);
    }).pipe(Effect.scoped),
);

it.effect(
  "recovers a lost commit response without reactivating the source or duplicating history",
  () =>
    Effect.gen(function* () {
      const { alpha, beta, input, loseCommit } = yield* fixture;
      yield* alpha.moves.request(input);
      loseCommit();
      yield* alpha.moves.drain();
      expect((yield* alpha.moves.status({ requestId: input.requestId })).state).toBe("committing");
      expect(
        (yield* alpha.moves.status({ requestId: input.requestId, cancel: true }).pipe(Effect.flip))
          .message,
      ).toContain("receipt");
      const count =
        (yield* beta.sql`SELECT COUNT(*) AS n FROM orchestration_events WHERE stream_id = ${threadId}`)[0]!
          .n;
      yield* alpha.moves.drain();
      expect((yield* alpha.moves.status({ requestId: input.requestId })).state).toBe("complete");
      expect(
        (yield* beta.sql`SELECT COUNT(*) AS n FROM orchestration_events WHERE stream_id = ${threadId}`)[0]!
          .n,
      ).toBe(count);
    }).pipe(Effect.scoped),
);

it.effect(
  "rejects an unavailable destination before holding the source, and safely cancels a held copy",
  () =>
    Effect.gen(function* () {
      const { alpha, input, offline, unlockSource } = yield* fixture;
      offline.add("beta");
      expect((yield* alpha.moves.request(input).pipe(Effect.flip)).message).toContain("offline");
      expect(yield* alpha.sql`SELECT 1 FROM custom_session_moves`).toHaveLength(0);
      offline.clear();
      yield* alpha.moves.request(input);
      offline.add("beta");
      yield* alpha.moves.drain();
      expect((yield* alpha.moves.status({ requestId: input.requestId })).error).toContain(
        "offline",
      );
      expect((yield* unlockSource()).state).toBe("cancelling");
      expect((yield* alpha.sql`SELECT locked FROM custom_session_moves`)[0]!.locked).toBe(1);
      offline.clear();
      expect((yield* unlockSource()).state).toBe("cancelled");
      expect((yield* alpha.sql`SELECT locked FROM custom_session_moves`)[0]!.locked).toBe(0);
    }).pipe(Effect.scoped),
);

it.effect("refuses a fresh native session and can cancel the verified-copy stage", () =>
  Effect.gen(function* () {
    const { alpha, beta, input, wrongResume, unlockSource } = yield* fixture;
    yield* alpha.moves.request(input);
    wrongResume();
    yield* alpha.moves.drain();
    expect(yield* alpha.moves.status({ requestId: input.requestId })).toMatchObject({
      state: "copying",
      error: expect.stringContaining("different session"),
    });
    expect((yield* beta.sql`SELECT locked FROM custom_session_moves`)[0]!.locked).toBe(1);
    expect((yield* unlockSource()).state).toBe("cancelled");
  }).pipe(Effect.scoped),
);

it.effect("keeps progress responsive and cancels during an in-flight file copy", () =>
  Effect.gen(function* () {
    const { alpha, beta, input, holdChunk } = yield* fixture;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    holdChunk({ entered, release });
    yield* alpha.moves.request(input);
    const draining = yield* alpha.moves.drain().pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    expect((yield* alpha.moves.status({ threadId })).state).toBe("copying");
    expect((yield* alpha.moves.status({ requestId: input.requestId, cancel: true })).state).toBe(
      "cancelled",
    );
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(draining);
    expect(yield* alpha.moves.status({ requestId: input.requestId })).toMatchObject({
      state: "cancelled",
      error: null,
    });
    expect(
      yield* beta.sql`SELECT 1 FROM projection_threads WHERE thread_id = ${threadId}`,
    ).toHaveLength(0);
    expect((yield* alpha.sql`SELECT locked FROM custom_session_moves`)[0]!.locked).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect(
  "finishes recovery after the source was archived but its final receipt was not saved",
  () =>
    Effect.gen(function* () {
      const { alpha, input } = yield* fixture;
      yield* alpha.moves.request(input);
      yield* alpha.moves.drain();
      const before =
        (yield* alpha.sql`SELECT COUNT(*) AS n FROM orchestration_events WHERE stream_id = ${threadId}`)[0]!
          .n;
      yield* alpha.sql`UPDATE custom_session_moves SET state = 'committing' WHERE id = ${input.requestId}`;
      yield* alpha.moves.drain();
      expect(yield* alpha.moves.status({ requestId: input.requestId })).toMatchObject({
        state: "complete",
        error: null,
      });
      expect(
        (yield* alpha.sql`SELECT COUNT(*) AS n FROM orchestration_events WHERE stream_id = ${threadId}`)[0]!
          .n,
      ).toBe(before);
    }).pipe(Effect.scoped),
);

it.effect(
  "moves back to a parked source, retaining new context and preserving single ownership",
  () =>
    Effect.gen(function* () {
      const { alpha, beta, input } = yield* fixture;
      yield* alpha.moves.request(input);
      yield* alpha.moves.drain();
      yield* beta.engine.dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make("new-history"),
        threadId,
        message: {
          messageId: MessageId.make("new-message"),
          text: "context added on beta",
          attachments: [],
        },
        createdAt: "2026-10-22T12:00:02.000Z",
      });
      yield* io(() =>
        NodeFSP.appendFile(NodePath.join(beta.home, transcriptName), "\nnew native context\n"),
      );
      const back = {
        requestId: CommandId.make("move-back"),
        threadId,
        environment: "alpha",
        projectId: alpha.projectId,
      };
      yield* beta.moves.request(back);
      yield* beta.moves.drain();
      expect(yield* beta.moves.status({ requestId: back.requestId })).toMatchObject({
        state: "complete",
        error: null,
      });
      expect(
        Option.getOrThrow(yield* alpha.snapshots.getThreadDetailById(threadId)).messages.some(
          (entry) => entry.text === "context added on beta",
        ),
      ).toBe(true);
      expect(
        yield* io(() => NodeFSP.readFile(NodePath.join(alpha.home, transcriptName), "utf8")),
      ).toContain("new native context");
      expect(
        (yield* alpha.sql`SELECT locked FROM custom_session_moves WHERE id = 'move-back'`)[0]!
          .locked,
      ).toBe(0);
    }).pipe(Effect.scoped),
);

it.effect(
  "moves a master while its third-computer worker retains ownership and delivers each held report once",
  () =>
    Effect.gen(function* () {
      const { alpha, beta, gamma, input } = yield* fixture;
      const workerId = ThreadId.make("third-computer-worker");
      yield* alpha.workers.spawn(threadId, {
        threadId: workerId,
        projectId: gamma.projectId,
        environment: "gamma",
        title: "Third computer worker",
        modelSelection: selection,
        prompt: "Finish the whole assignment",
      });
      yield* alpha.workers.control(threadId, { threadId: workerId, notifications: false });
      yield* gamma.workers.report(workerId, {
        clientRequestId: "held",
        outcome: "done",
        summary: "The third computer result",
        evidence: "/test/evidence",
      });
      yield* alpha.moves.request(input);
      yield* alpha.moves.drain();
      expect(yield* alpha.moves.status({ requestId: input.requestId })).toMatchObject({
        state: "complete",
        error: null,
      });
      expect((yield* beta.workers.list(threadId))[0]).toMatchObject({
        threadId: workerId,
        ownerThreadId: threadId,
        environment: "gamma",
        notifications: false,
      });
      expect(
        (yield* gamma.sql`SELECT owner_id FROM custom_workers WHERE thread_id = ${workerId}`)[0]!
          .owner_id,
      ).toBe("peer:beta:" + threadId);
      expect(
        (yield* alpha.workers
          .send(threadId, {
            threadId: workerId,
            clientRequestId: "old-owner",
            prompt: "should fail",
          })
          .pipe(Effect.flip)).message,
      ).toContain("own");
      yield* beta.workers.control(threadId, { threadId: workerId, notifications: true });
      yield* gamma.workers.drain();
      yield* beta.workers.drain();
      const messages = Option.getOrThrow(
        yield* beta.snapshots.getThreadDetailById(threadId),
      ).messages;
      expect(
        messages.filter((message) => message.text.includes("The third computer result")),
      ).toHaveLength(1);
      yield* gamma.workers.report(workerId, {
        clientRequestId: "held",
        outcome: "done",
        summary: "The third computer result",
        evidence: "/test/evidence",
      });
      yield* gamma.workers.drain();
      yield* beta.workers.drain();
      expect(
        Option.getOrThrow(yield* beta.snapshots.getThreadDetailById(threadId)).messages.filter(
          (message) => message.text.includes("The third computer result"),
        ),
      ).toHaveLength(1);
    }).pipe(Effect.scoped),
);

it.effect(
  "moves worker execution while its master on a third computer keeps control and receives reports",
  () =>
    Effect.gen(function* () {
      const { alpha, beta, gamma, input } = yield* fixture;
      const master = ThreadId.make("third-computer-master");
      yield* gamma.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-third-master"),
        threadId: master,
        projectId: gamma.projectId,
        title: "Existing master",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "plan",
        branch: null,
        worktreePath: null,
        historyImport: true,
        createdAt: timestamp,
      });
      const plan = {
        threadId,
        projectId: alpha.projectId,
        title: "Existing worker",
        modelSelection: selection,
        prompt: "Continue the assignment",
        runtimeMode: "full-access",
        interactionMode: "plan",
        ownerRuntimeMode: "full-access",
      };
      yield* alpha.sql`INSERT INTO custom_workers (thread_id, owner_id, source_id, plan_json, baseline, state, error, notify, read_seq, read_offset)
    VALUES (${threadId}, ${"peer:gamma:" + master}, NULL, ${encodeUnknown(plan)}, 0, 'ready', NULL, 0, 0, 0)`;
      yield* gamma.sql`INSERT INTO custom_workers (thread_id, owner_id, source_id, plan_json, baseline, state, error, notify, read_seq, read_offset)
    VALUES (${threadId}, ${master}, NULL, ${encodeUnknown({ ...plan, environmentId: "alpha" })}, 0, 'remote', NULL, 0, 0, 0)`;
      yield* alpha.moves.request(input, threadId);
      yield* alpha.moves.drain();
      expect(yield* alpha.moves.status({ requestId: input.requestId })).toMatchObject({
        state: "complete",
        error: null,
      });
      expect((yield* gamma.workers.list(master))[0]).toMatchObject({
        threadId,
        ownerThreadId: master,
        environment: "beta",
      });
      yield* gamma.workers.control(master, { threadId, notifications: true });
      yield* beta.workers.report(threadId, {
        clientRequestId: "moved-result",
        outcome: "done",
        summary: "Finished on the new computer",
        evidence: "/test/result",
      });
      yield* beta.workers.drain();
      yield* gamma.workers.drain();
      expect(
        Option.getOrThrow(yield* gamma.snapshots.getThreadDetailById(master)).messages.filter(
          (message) => message.text.includes("Finished on the new computer"),
        ),
      ).toHaveLength(1);
    }).pipe(Effect.scoped),
);

it.effect("retries a cancelled copy to the same computer without losing newer source context", () =>
  Effect.gen(function* () {
    const { alpha, beta, input, wrongResume, restoreResume } = yield* fixture;
    yield* alpha.moves.request(input);
    wrongResume();
    yield* alpha.moves.drain();
    yield* alpha.moves.status({ requestId: input.requestId, cancel: true });
    yield* io(() =>
      NodeFSP.appendFile(
        NodePath.join(alpha.home, transcriptName),
        "\nnew source context after cancellation\n",
      ),
    );
    restoreResume();
    const retry = { ...input, requestId: CommandId.make("retry-after-cancel") };
    yield* alpha.moves.request(retry);
    yield* alpha.moves.drain();
    expect(yield* alpha.moves.status({ requestId: retry.requestId })).toMatchObject({
      state: "complete",
      error: null,
    });
    expect(
      yield* io(() => NodeFSP.readFile(NodePath.join(beta.home, transcriptName), "utf8")),
    ).toContain("new source context after cancellation");
  }).pipe(Effect.scoped),
);

it.effect(
  "retries the original request after native resume appended private destination metadata",
  () =>
    Effect.gen(function* () {
      const { alpha, beta, input, wrongResume, restoreResume, bytes } = yield* fixture;
      yield* alpha.moves.request(input);
      wrongResume();
      yield* alpha.moves.drain();
      yield* io(() =>
        NodeFSP.appendFile(NodePath.join(beta.home, transcriptName), "\nnative resume metadata\n"),
      );
      restoreResume();
      yield* alpha.moves.request(input);
      yield* alpha.moves.drain();
      expect(yield* alpha.moves.status({ requestId: input.requestId })).toMatchObject({
        state: "complete",
        error: null,
      });
      expect(yield* io(() => NodeFSP.readFile(NodePath.join(beta.home, transcriptName)))).toEqual(
        bytes,
      );
      expect(
        Option.getOrThrow(yield* beta.snapshots.getThreadDetailById(threadId)).messages,
      ).toHaveLength(2);
    }).pipe(Effect.scoped),
);
