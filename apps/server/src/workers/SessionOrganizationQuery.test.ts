import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { makeSessionOrganizationQuery } from "./SessionOrganizationQuery.ts";

it.effect(
  "enriches a large shell with persisted ownership, remote children and authenticated direct input",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const read = yield* makeSessionOrganizationQuery;
      const ids = Array.from({ length: 1001 }, (_, i) => ThreadId.make(`thread-${i}`));
      yield* sql`INSERT INTO custom_workers(thread_id,owner_id,plan_json,state) VALUES (${ids[1]},${ids[0]},'{}','ready'),(${ids[2]},${ids[0]},'{"environmentId":"remote"}','remote')`;
      yield* sql`INSERT INTO custom_orchestrator_authority(thread_id,revision) VALUES (${ids[1]},7)`;
      yield* sql`INSERT INTO custom_worker_jobs(id,worker_id,target_id,kind,prompt,created_at,state,turn_id) VALUES ('direct:job',${ids[1]},${ids[1]},'work','','2026-11-01T00:00:00.000Z','submitted','run')`;
      const payload = JSON.stringify({ createdBy: "user", role: "user", runId: "run" });
      yield* sql`INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,run_id,node_id,role,streaming,created_at,updated_at,payload_json) VALUES ('message',${ids[1]},'run',NULL,'user',0,'2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z',${payload})`;
      const shell = yield* read(ids);
      assert.equal(shell.size, 1001);
      assert.deepEqual(shell.get(ids[0]!)?.workers, [
        { environmentId: null, threadId: ids[1]!, revision: 7 },
        { environmentId: "remote", threadId: ids[2]!, revision: 0 },
      ]);
      assert.equal(shell.get(ids[1]!)?.directInputAt, "2026-11-01T00:00:00.000Z");
      assert.equal(shell.get(ids[1]!)?.revision, 7);
      assert.equal(shell.get(ids[1000]!)?.owner, null);
      yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = '{"createdBy":"agent","role":"user","runId":"run"}' WHERE message_id = 'message'`;
      assert.equal((yield* read([ids[1]!])).get(ids[1]!)?.directInputAt, null);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
