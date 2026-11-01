import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EventId,
  NodeId,
  PlanId,
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
    plan_id: string;
    plan_markdown: string;
    created_at: string;
    updated_at: string;
    implemented_at: string | null;
    implementation_thread_id: string | null;
  }>`SELECT * FROM projection_thread_proposed_plans WHERE thread_id = ${threadId} ORDER BY created_at, plan_id`;
  const turns = yield* sql<{
    row_id: number;
    turn_id: string | null;
    checkpoint_ref: string;
    checkpoint_status: string;
    checkpoint_turn_count: number;
    checkpoint_files_json: string;
    completed_at: string | null;
    requested_at: string;
  }>`SELECT * FROM projection_turns WHERE thread_id = ${threadId} AND checkpoint_ref IS NOT NULL ORDER BY checkpoint_turn_count, row_id`;
  if (activities.length + plans.length + turns.length === 0) return [];
  const thread = (yield* sql<{ cwd: string; created_at: string; updated_at: string }>`
    SELECT COALESCE(t.worktree_path, p.workspace_root) AS cwd, t.created_at, t.updated_at
    FROM projection_threads t JOIN projection_projects p ON p.project_id = t.project_id
    WHERE t.thread_id = ${threadId}
  `)[0];
  if (!thread) return [];
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
  const items: Array<OrchestrationV2TurnItem> = [];
  const base = (id: string, at: string) => ({
    id: TurnItemId.make(`migration:v1:${id}`),
    threadId,
    runId: null,
    nodeId,
    providerThreadId: null,
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
      ...base(`activity:${activity.activity_id}`, activity.created_at),
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
        nodeId,
        runId: null,
        kind: "proposed_plan",
        status: plan.implemented_at ? "completed" : "active",
        markdown: plan.plan_markdown,
      },
    });
    items.push({
      ...base(`plan:${plan.plan_id}`, plan.created_at),
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
      const checkpointId = CheckpointId.make(`migration:v1:checkpoint:${threadId}:${turn.row_id}`);
      const at = turn.completed_at ?? turn.requested_at;
      const files = Option.getOrElse(decodeFiles(turn.checkpoint_files_json), () => []);
      const status =
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
          runId: null,
          nodeId,
          parentCheckpointId,
          ordinalWithinScope: index,
          appRunOrdinal: null,
          ref: CheckpointRef.make(turn.checkpoint_ref),
          status,
          files,
          capturedAt: DateTime.makeUnsafe(at),
        },
      });
      items.push({
        ...base(`checkpoint:${threadId}:${turn.row_id}`, at),
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
