import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EventId,
  NodeId,
  PlanId,
  MessageId,
  ModelSelection,
  RunId,
  RunAttemptId,
  ProviderTurnId,
  OrchestrationV2AppThreadJson,
  OrchestrationV2ProviderThreadJson,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  OrchestrationV2CheckpointFileSummary,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const decodeFiles = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(OrchestrationV2CheckpointFileSummary)),
);

const decodeApp = Schema.decodeEffect(Schema.fromJsonString(OrchestrationV2AppThreadJson));
const decodeProvider = Schema.decodeEffect(
  Schema.fromJsonString(OrchestrationV2ProviderThreadJson),
);
const decodeCursor = Schema.decodeOption(
  Schema.fromJsonString(
    Schema.Struct({
      turnCount: Schema.optionalKey(Schema.Number),
      turnStartMessageIds: Schema.optionalKey(Schema.Array(Schema.NullOr(Schema.String))),
      resumeSessionAt: Schema.optionalKey(Schema.String),
    }),
  ),
);
const decodeRequest = Schema.decodeOption(
  Schema.fromJsonString(
    Schema.Struct({
      messageId: Schema.String,
      modelSelection: ModelSelection,
      runtimeMode: Schema.optionalKey(Schema.String),
      interactionMode: Schema.optionalKey(Schema.String),
    }),
  ),
);

/** Import historical records without reviving provider actions, approvals, or jobs. */
export const readHistoryEvents = Effect.fn("LegacyV1History.read")(function* (
  threadId: ThreadId,
  messageCount: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`;
  const names = new Set(tables.map((row) => row.name));
  // An earlier preview already deleted these tables. The original V1 file is still the recovery source.
  if (
    !["projection_thread_activities", "projection_turns", "projection_thread_proposed_plans"].every(
      (name) => names.has(name),
    )
  )
    return [];
  const activities = yield* sql<{
    activity_id: string;
    kind: string;
    tone: string;
    summary: string;
    payload_json: string;
    created_at: string;
    turn_id: string | null;
  }>`SELECT * FROM projection_thread_activities WHERE thread_id = ${threadId} ORDER BY created_at, sequence, activity_id`;
  const plans = yield* sql<{
    turn_id: string | null;
    plan_id: string;
    plan_markdown: string;
    created_at: string;
    updated_at: string;
    implemented_at: string | null;
    implementation_thread_id: string | null;
  }>`SELECT * FROM projection_thread_proposed_plans WHERE thread_id = ${threadId} ORDER BY created_at, plan_id`;
  const turns = yield* sql<{
    row_id: number;
    pending_message_id: string | null;
    state: string;
    started_at: string | null;
    source_proposed_plan_thread_id: string | null;
    source_proposed_plan_id: string | null;
    turn_id: string | null;
    checkpoint_ref: string | null;
    checkpoint_status: string;
    checkpoint_turn_count: number | null;
    checkpoint_files_json: string;
    completed_at: string | null;
    requested_at: string;
  }>`SELECT * FROM projection_turns WHERE thread_id = ${threadId} ORDER BY requested_at, row_id`;
  if (activities.length + plans.length + turns.length === 0) return [];
  const thread = (yield* sql<{ cwd: string; created_at: string; updated_at: string }>`
    SELECT COALESCE(t.worktree_path, p.workspace_root) AS cwd, t.created_at, t.updated_at
    FROM projection_threads t JOIN projection_projects p ON p.project_id = t.project_id
    WHERE t.thread_id = ${threadId}
  `)[0];
  if (!thread) return [];
  const appRow = (yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM orchestration_events
     WHERE event_id = ${`migration:v1:thread:${threadId}:created`}
       AND application_event_version = 2`)[0];
  if (!appRow) return [];
  const app = yield* decodeApp(appRow.payload_json);
  // Hydration can race a provider switch. Historical turns belong to the original
  // imported binding, never whichever account/provider happens to be active now.
  const providerRow = (yield* sql<{
    payload_json: string;
  }>`SELECT provider.payload_json FROM orchestration_v2_projection_provider_threads provider
     JOIN orchestration_events imported ON provider.provider_thread_id = json_extract(imported.payload_json, '$.id')
     WHERE imported.event_id = ${`migration:v1:thread:${threadId}:native`}
       AND imported.application_event_version = 2`)[0];
  const provider = providerRow ? yield* decodeProvider(providerRow.payload_json) : undefined;
  const cursorRow = (yield* sql<{
    resume_cursor_json: string;
  }>`SELECT resume_cursor_json FROM provider_session_runtime WHERE thread_id = ${threadId}`)[0];
  const cursor = cursorRow
    ? Option.getOrUndefined(decodeCursor(cursorRow.resume_cursor_json))
    : undefined;
  const requests = yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM orchestration_events
    WHERE aggregate_kind = 'thread' AND stream_id = ${threadId} AND event_type = 'thread.turn-start-requested'
    ORDER BY sequence`;
  const starts = new Map(
    requests.flatMap((row) => {
      const decoded = Option.getOrUndefined(decodeRequest(row.payload_json));
      return decoded ? [[decoded.messageId, decoded] as const] : [];
    }),
  );
  const nativeMessageParts =
    provider?.driver === "opencode"
      ? yield* sql<{
          message_id: string;
          turn_id: string | null;
        }>`SELECT message_id, turn_id FROM projection_thread_messages WHERE thread_id = ${threadId} AND role = 'assistant'`
      : [];
  const openCodeEvidence = new Map<
    string,
    { messagePartIds: Set<string>; toolCallIds: Set<string> }
  >();
  const evidenceFor = (turnId: string) => {
    let evidence = openCodeEvidence.get(turnId);
    if (!evidence) {
      evidence = { messagePartIds: new Set(), toolCallIds: new Set() };
      openCodeEvidence.set(turnId, evidence);
    }
    return evidence;
  };
  for (const message of nativeMessageParts)
    if (message.turn_id && message.message_id.startsWith("assistant:"))
      evidenceFor(message.turn_id).messagePartIds.add(
        message.message_id.slice("assistant:".length).replace(/:segment:\d+$/, ""),
      );
  if (provider?.driver === "opencode")
    for (const activity of activities) {
      if (!activity.turn_id) continue;
      const payload = Option.getOrUndefined(decodePayload(activity.payload_json));
      if (
        typeof payload === "object" &&
        payload !== null &&
        "toolCallId" in payload &&
        typeof payload.toolCallId === "string"
      )
        evidenceFor(activity.turn_id).toolCallIds.add(payload.toolCallId);
    }
  const lastCheckpointCount = Math.max(0, ...turns.map((turn) => turn.checkpoint_turn_count ?? 0));
  const nodeId = NodeId.make(`migration:v1:history:${threadId}`);
  const scopeId = CheckpointScopeId.make(`migration:v1:checkpoints:${threadId}`);
  const createdAt = DateTime.makeUnsafe(thread.created_at);
  const updatedAt = DateTime.makeUnsafe(thread.updated_at);
  const events: Array<OrchestrationV2DomainEvent> = [
    {
      id: EventId.make(`${nodeId}:node`),
      type: "node.updated",
      threadId,
      occurredAt: updatedAt,
      payload: {
        id: nodeId,
        threadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "system",
        status: "completed",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: turns.length ? scopeId : null,
        startedAt: createdAt,
        completedAt: updatedAt,
      },
    },
  ];
  if (provider && turns.length)
    events.push({
      id: EventId.make(`migration:v1:history:${threadId}:provider-range`),
      type: "provider-thread.updated",
      threadId,
      occurredAt: updatedAt,
      payload: { ...provider, firstRunOrdinal: 1, lastRunOrdinal: turns.length },
    });
  const items: Array<OrchestrationV2TurnItem> = [];
  const turnRowsById = new Map(
    turns.filter((turn) => turn.turn_id !== null).map((turn) => [turn.turn_id, turn]),
  );
  const runForTurn = (turnId: string | null) => {
    const row = turnId ? turnRowsById.get(turnId) : undefined;
    return row ? RunId.make(`migration:v1:run:${threadId}:${row.row_id}`) : null;
  };
  const base = (id: string, at: string, turnId: string | null = null) => ({
    id: TurnItemId.make(`migration:v1:${id}`),
    threadId,
    runId: runForTurn(turnId),
    nodeId: runForTurn(turnId) ? NodeId.make(`${runForTurn(turnId)}:root`) : nodeId,
    providerThreadId: runForTurn(turnId) ? (provider?.id ?? null) : null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: DateTime.makeUnsafe(at),
    completedAt: DateTime.makeUnsafe(at),
    updatedAt: DateTime.makeUnsafe(at),
  });
  for (const activity of activities) {
    const payload = Option.getOrElse(
      decodePayload(activity.payload_json),
      () => activity.payload_json,
    );
    items.push({
      ...base(`activity:${activity.activity_id}`, activity.created_at, activity.turn_id),
      type: "dynamic_tool",
      title: activity.summary,
      toolName: activity.kind.trim() || "legacy_activity",
      input: null,
      output: {
        kind: activity.kind,
        tone: activity.tone,
        summary: activity.summary,
        turnId: activity.turn_id,
        payload,
      },
    });
  }
  for (const plan of plans) {
    const planId = PlanId.make(plan.plan_id);
    events.push({
      id: EventId.make(`migration:v1:plan:${plan.plan_id}`),
      type: "plan.updated",
      threadId,
      occurredAt: DateTime.makeUnsafe(plan.updated_at),
      payload: {
        id: planId,
        threadId,
        nodeId: runForTurn(plan.turn_id) ? NodeId.make(`${runForTurn(plan.turn_id)}:root`) : nodeId,
        runId: runForTurn(plan.turn_id),
        kind: "proposed_plan",
        status: plan.implemented_at ? "completed" : "active",
        markdown: plan.plan_markdown,
        ...(plan.implemented_at
          ? {
              implementation: {
                threadId: plan.implementation_thread_id
                  ? ThreadId.make(plan.implementation_thread_id)
                  : null,
                implementedAt: plan.implemented_at,
              },
            }
          : {}),
      },
    });
    items.push({
      ...base(`plan:${plan.plan_id}`, plan.created_at, plan.turn_id),
      type: "proposed_plan",
      planId,
      markdown: plan.plan_markdown,
      streaming: false,
    });
  }
  if (turns.length) {
    events.push({
      id: EventId.make(`${scopeId}:created`),
      type: "checkpoint-scope.created",
      threadId,
      occurredAt: createdAt,
      payload: {
        id: scopeId,
        threadId,
        runId: null,
        nodeId,
        parentScopeId: null,
        providerThreadId: null,
        kind: "manual",
        ordinalWithinParent: 0,
        advancesAppRunCount: false,
        cwd: thread.cwd,
        createdAt,
      },
    });
    let parentCheckpointId: CheckpointId | null = null;
    for (const [index, turn] of turns.entries()) {
      const runId = RunId.make(`migration:v1:run:${threadId}:${turn.row_id}`);
      const rootNodeId = NodeId.make(`${runId}:root`);
      const attemptId = RunAttemptId.make(`${runId}:attempt`);
      const ordinal = index + 1;
      const request = turn.pending_message_id ? starts.get(turn.pending_message_id) : undefined;
      const selection = request?.modelSelection ?? app.modelSelection;
      const matchingProvider =
        provider?.providerInstanceId === selection.instanceId ? provider : undefined;
      // V1 Codex turn ids are native ids. Other adapters used local UUIDs; treating
      // those UUIDs as native boundaries can rewind the wrong conversation.
      const nativeTurnId = matchingProvider?.driver === "codex" ? turn.turn_id : null;
      const count = turn.checkpoint_turn_count;
      const legacyClaudeBoundary =
        matchingProvider?.driver === "claudeAgent" &&
        count !== null &&
        count > 0 &&
        cursor?.turnCount === lastCheckpointCount &&
        cursor.turnStartMessageIds?.length === lastCheckpointCount
          ? count < lastCheckpointCount && cursor.turnStartMessageIds[count]
            ? { nextUserMessageId: cursor.turnStartMessageIds[count] }
            : count === lastCheckpointCount && cursor.resumeSessionAt
              ? { headMessageId: cursor.resumeSessionAt }
              : cursor.turnStartMessageIds.every((id) => id === null)
                ? {
                    recoverTurnStarts: {
                      retainedTurnCount: count,
                      turnCount: lastCheckpointCount,
                      ...(cursor.resumeSessionAt
                        ? { sourceHeadMessageId: cursor.resumeSessionAt }
                        : {}),
                    },
                  }
                : undefined
          : undefined;
      const legacyOpenCodeBoundary =
        matchingProvider?.driver === "opencode" && count !== null && count > 0
          ? {
              retainedTurnCount: count,
              turnCount: lastCheckpointCount,
              messagePartIds: [
                ...(openCodeEvidence.get(turn.turn_id ?? "")?.messagePartIds ?? []),
              ].sort(),
              toolCallIds: [
                ...(openCodeEvidence.get(turn.turn_id ?? "")?.toolCallIds ?? []),
              ].sort(),
            }
          : undefined;
      const providerTurnId =
        matchingProvider && (nativeTurnId || legacyClaudeBoundary || legacyOpenCodeBoundary)
          ? ProviderTurnId.make(`${runId}:provider-turn`)
          : null;
      const status =
        turn.state === "completed"
          ? "completed"
          : turn.state === "error"
            ? "failed"
            : "interrupted";
      const occurredAt = DateTime.makeUnsafe(turn.completed_at ?? turn.requested_at);
      const startedAt = turn.started_at ? DateTime.makeUnsafe(turn.started_at) : null;
      const checkpointId = turn.checkpoint_ref
        ? CheckpointId.make(`migration:v1:checkpoint:${threadId}:${turn.row_id}`)
        : null;
      events.push(
        {
          id: EventId.make(`${runId}:created`),
          type: "run.created",
          threadId,
          occurredAt,
          payload: {
            legacyV1: {
              turnId: turn.turn_id,
              state: turn.state,
              modelSelectionRecovered: request !== undefined,
              ...(request?.runtimeMode ? { runtimeMode: request.runtimeMode } : {}),
              ...(request?.interactionMode ? { interactionMode: request.interactionMode } : {}),
            },
            id: runId,
            threadId,
            ordinal,
            providerInstanceId: selection.instanceId,
            modelSelection: selection,
            providerThreadId: matchingProvider?.id ?? null,
            // Some V1 records have lost their initiating message; retain an audit-only
            // reference rather than manufacturing a user message or replaying a turn.
            userMessageId: MessageId.make(
              turn.pending_message_id ?? `${runId}:missing-user-message`,
            ),
            rootNodeId,
            activeAttemptId: matchingProvider ? attemptId : null,
            status,
            requestedAt: DateTime.makeUnsafe(turn.requested_at),
            startedAt,
            completedAt: occurredAt,
            checkpointId,
            contextHandoffId: null,
            ...(turn.source_proposed_plan_thread_id && turn.source_proposed_plan_id
              ? {
                  sourcePlanRef: {
                    threadId: ThreadId.make(turn.source_proposed_plan_thread_id),
                    planId: PlanId.make(turn.source_proposed_plan_id),
                  },
                }
              : {}),
          },
        },
        {
          id: EventId.make(`${rootNodeId}:created`),
          type: "node.updated",
          threadId,
          occurredAt,
          payload: {
            id: rootNodeId,
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId,
            kind: "root_turn",
            status,
            countsForRun: true,
            providerThreadId: matchingProvider?.id ?? null,
            providerTurnId,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: scopeId,
            startedAt,
            completedAt: occurredAt,
          },
        },
      );
      if (matchingProvider)
        events.push({
          id: EventId.make(`${attemptId}:created`),
          type: "run-attempt.created",
          threadId,
          occurredAt,
          payload: {
            id: attemptId,
            runId,
            attemptOrdinal: 1,
            rootNodeId,
            providerInstanceId: matchingProvider.providerInstanceId,
            providerThreadId: matchingProvider.id,
            providerTurnId,
            reason: "initial",
            status,
            startedAt,
            completedAt: occurredAt,
            // The V1 runtime row identifies the current session, not necessarily
            // this historical attempt's original destination after renewals.
            // Native membership is validated before rollback; do not invent it here.
          },
        });
      if (matchingProvider && providerTurnId)
        events.push({
          id: EventId.make(`${providerTurnId}:created`),
          type: "provider-turn.updated",
          threadId,
          occurredAt,
          payload: {
            id: providerTurnId,
            providerThreadId: matchingProvider.id,
            nodeId: rootNodeId,
            runAttemptId: attemptId,
            nativeTurnRef: nativeTurnId
              ? { driver: matchingProvider.driver, nativeId: nativeTurnId, strength: "strong" }
              : null,
            ...(legacyClaudeBoundary ? { legacyClaudeBoundary } : {}),
            ...(legacyOpenCodeBoundary ? { legacyOpenCodeBoundary } : {}),
            historyOrigin: "v1_import",
            ordinal,
            status,
            startedAt,
            completedAt: occurredAt,
          },
        });
      if (!turn.checkpoint_ref || !checkpointId) continue;
      const at = turn.completed_at ?? turn.requested_at;
      const files = Option.getOrElse(decodeFiles(turn.checkpoint_files_json), () => []);
      const checkpointStatus =
        turn.checkpoint_status === "ready"
          ? "ready"
          : turn.checkpoint_status === "error"
            ? "error"
            : "missing";
      events.push({
        id: EventId.make(`${checkpointId}:captured`),
        type: "checkpoint.captured",
        threadId,
        occurredAt: DateTime.makeUnsafe(at),
        payload: {
          id: checkpointId,
          threadId,
          scopeId,
          runId,
          nodeId: rootNodeId,
          parentCheckpointId,
          ordinalWithinScope: index,
          appRunOrdinal: ordinal,
          legacyV1: {
            turnId: turn.turn_id,
            checkpointTurnCount: turn.checkpoint_turn_count,
            ...(!providerTurnId
              ? {
                  rollbackUnavailableReason:
                    "The V1 record has no recoverable native rollback boundary for this provider. Its Git checkpoint is preserved for inspection.",
                }
              : {}),
          },
          ref: CheckpointRef.make(turn.checkpoint_ref),
          status: checkpointStatus,
          files,
          capturedAt: DateTime.makeUnsafe(at),
        },
      });
      items.push({
        ...base(`checkpoint:${threadId}:${turn.row_id}`, at, turn.turn_id),
        type: "checkpoint",
        checkpointId,
        scopeId,
        files,
      });
      parentCheckpointId = checkpointId;
    }
  }
  items.sort(
    (a, b) =>
      a.updatedAt.epochMilliseconds - b.updatedAt.epochMilliseconds || a.id.localeCompare(b.id),
  );
  for (const [index, item] of items.entries())
    events.push({
      id: EventId.make(`${item.id}:item`),
      type: "turn-item.updated",
      threadId,
      occurredAt: item.updatedAt,
      payload: { ...item, ordinal: messageCount + index + 1 },
    });
  return events;
});
