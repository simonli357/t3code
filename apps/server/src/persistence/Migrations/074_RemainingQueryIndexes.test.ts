import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("fresh migrations index the remaining event, approval, search and worker queries", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const queries = [
      {
        query: `SELECT payload_json FROM orchestration_events WHERE event_type IN ('thread.created', 'thread.meta-updated', 'thread.turn-start-requested')`,
        indexes: ["idx_orch_events_type"],
      },
      {
        query: `SELECT ROW_NUMBER() OVER (PARTITION BY json_extract(payload_json, '$.requestId') ORDER BY occurred_at DESC, sequence DESC)
          FROM orchestration_events WHERE event_type = 'thread.approval-response-requested' AND json_extract(payload_json, '$.requestId') IS NOT NULL`,
        indexes: ["idx_orch_events_approval_request_order"],
      },
      ...["approval.requested", "approval.resolved", "provider.approval.respond.failed"].map(
        (kind) => ({
          query: `SELECT ROW_NUMBER() OVER (PARTITION BY json_extract(payload_json, '$.requestId') ORDER BY created_at ${kind === "approval.requested" ? "ASC" : "DESC"}, activity_id ${kind === "approval.requested" ? "ASC" : "DESC"})
          FROM projection_thread_activities WHERE kind = '${kind}' AND json_extract(payload_json, '$.requestId') IS NOT NULL`,
          indexes: [
            kind === "approval.requested"
              ? "idx_activities_approval_request_first"
              : "idx_activities_approval_request_latest",
          ],
        }),
      ),
      {
        query: `SELECT ROW_NUMBER() OVER (PARTITION BY json_extract(payload_json, '$.requestId') ORDER BY created_at DESC, activity_id DESC)
          FROM projection_thread_activities WHERE thread_id = 'thread'
            AND (kind IN ('user-input.requested', 'user-input.resolved') OR kind = 'provider.user-input.respond.failed')
            AND json_extract(payload_json, '$.requestId') IS NOT NULL`,
        indexes: ["idx_activities_thread_request_latest"],
      },
      {
        query: `SELECT state, turn_id FROM projection_turns AS t
          WHERE thread_id = 'thread' AND turn_id IS NOT NULL AND pending_message_id IS NULL AND requested_at >= '2026-10-26'
            AND NOT EXISTS (SELECT 1 FROM custom_worker_jobs WHERE turn_id = t.turn_id AND kind = 'work') ORDER BY row_id LIMIT 1`,
        indexes: ["idx_turns_worker_claim", "idx_worker_jobs_work_turn"],
      },
      {
        query: `SELECT thread_id, source_proposed_plan_thread_id FROM projection_turns
          WHERE source_proposed_plan_thread_id IS NOT NULL AND source_proposed_plan_thread_id <> thread_id`,
        indexes: ["idx_turns_source_plan"],
      },
      {
        query: `SELECT assistant_message_id FROM projection_turns WHERE assistant_message_id IS NOT NULL`,
        indexes: ["idx_turns_assistant_message"],
      },
      {
        query: `SELECT message_id FROM projection_thread_messages WHERE thread_id = 'thread' AND is_streaming = 0
          ORDER BY CASE role WHEN 'user' THEN 0 ELSE 1 END, created_at DESC, message_id`,
        indexes: ["idx_messages_search_order"],
      },
    ];
    for (const { query, indexes } of queries) {
      const plan = (yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`))
        .map((row) => row.detail)
        .join("\n");
      for (const index of indexes) expect(plan, query).toContain(index);
      expect(plan, query).not.toContain("USE TEMP B-TREE");
    }
    const searchPlan = (yield* sql.unsafe<{ detail: string }>(
      `EXPLAIN QUERY PLAN WITH ranked AS (
          SELECT
            threads.thread_id AS thread_id,
            threads.project_id AS project_id,
            CASE messages.role
              WHEN 'user' THEN 'user'
              ELSE 'assistant'
            END AS source,
            messages.text AS match_text,
            messages.created_at AS message_created_at,
            CASE messages.role
              WHEN 'user' THEN 0
              ELSE 1
            END AS match_rank,
            threads.updated_at AS thread_updated_at,
            ROW_NUMBER() OVER (
              PARTITION BY threads.thread_id
              ORDER BY
                CASE messages.role
                  WHEN 'user' THEN 0
                  ELSE 1
                END ASC,
                messages.created_at DESC,
                messages.message_id ASC
            ) AS thread_match_rank
          FROM projection_thread_messages AS messages
          INNER JOIN projection_threads AS threads
            ON threads.thread_id = messages.thread_id
          INNER JOIN projection_projects AS projects
            ON projects.project_id = threads.project_id
          WHERE threads.deleted_at IS NULL
            AND threads.archived_at IS NULL
            AND projects.deleted_at IS NULL
            AND messages.is_streaming = 0
            
            
            
            
            AND (
              messages.role = 'user'
              OR (
                messages.role = 'assistant'
                AND messages.message_id IN (
                  SELECT turns.assistant_message_id
                  FROM projection_turns AS turns
                  WHERE turns.assistant_message_id IS NOT NULL
                )
              )
            )
            AND messages.text LIKE ? ESCAPE '!'
        )
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          source,
          match_text AS "matchText",
          message_created_at AS "messageCreatedAt"
        FROM ranked
        WHERE thread_match_rank = 1
        ORDER BY
          match_rank ASC,
          thread_updated_at DESC,
          thread_id ASC
        LIMIT ?`,
      ["%term%", 20],
    ))
      .map((row) => row.detail)
      .join("\n");
    for (const index of [
      "idx_threads_message_search",
      "idx_messages_search_order",
      "idx_turns_assistant_message",
    ]) {
      expect(searchPlan).toContain(index);
    }
    // Only the final ranking of one result per thread still needs a sort.
    expect(searchPlan.match(/USE TEMP B-TREE FOR ORDER BY/g)).toHaveLength(1);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
