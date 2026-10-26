// Match migration 072's partial index. A session with no explicit user intent
// must be an empty seek, not a reverse scan through ordinary provider events.
export const renewalIntentSql = `SELECT event_type FROM orchestration_events
  INDEXED BY idx_worker_renewal_intent
  WHERE stream_id = ? AND event_type IN ('thread.turn-interrupt-requested', 'thread.turn-start-requested')
    AND (command_id IS NULL OR (command_id NOT LIKE 'renewal:%' AND command_id NOT LIKE 'worker-job:%'))
  ORDER BY sequence DESC LIMIT 1`;

// Manual handoffs/report wake-ups retain their existing intent rule: a renewal
// checkpoint may resume them, but a worker report cannot undo the user's Stop.
export const workerWakeIntentSql = `SELECT event_type FROM orchestration_events
  INDEXED BY idx_worker_wake_intent
  WHERE aggregate_kind = 'thread' AND stream_id = ?
    AND event_type IN ('thread.turn-interrupt-requested', 'thread.turn-start-requested')
    AND (command_id IS NULL OR command_id NOT LIKE 'worker-job:%')
  ORDER BY sequence DESC LIMIT 1`;

// Group only actual tool calls, in index order. Ordinary thread activities can
// greatly outnumber calls and must not be reread to measure working time.
export const renewalToolWaitsSql = `SELECT
  MIN(CASE WHEN a.kind = 'tool.started' THEN a.created_at END) AS start,
  COALESCE(MAX(CASE WHEN a.kind = 'tool.completed' THEN a.created_at END), t.completed_at) AS end
  FROM projection_thread_activities a INDEXED BY idx_worker_renewal_tool_wait
  JOIN projection_turns t ON t.thread_id = a.thread_id AND t.turn_id = a.turn_id
  WHERE a.thread_id = ? AND a.kind IN ('tool.started', 'tool.completed')
    AND json_extract(a.payload_json, '$.toolCallId') IS NOT NULL
  GROUP BY a.turn_id, json_extract(a.payload_json, '$.toolCallId')`;
