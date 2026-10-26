import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("combined session migrations", (it) => {
  it.effect(
    "advances schema67 through Base68 and Workspace69 without changing ownership or policies",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 67 });
        const model =
          '{"instanceId":"exact-account","model":"exact-model","options":[{"id":"effort","value":"high"}]}';
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,default_model_selection_json,scripts_json,created_at,updated_at)
        VALUES ('project','Project','/persistent/project',${model},'[]','2026-10-24','2026-10-24')`;
        yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at,settled_override)
        VALUES ('source','project','Base candidate',${model},'approval-required','plan','2026-10-24','2026-10-24','settled')`;
        yield* sql`INSERT INTO custom_workers (thread_id,owner_id,source_id,plan_json,state) VALUES ('source','master','original','{"keep":"plan"}','idle')`;
        yield* sql`INSERT INTO model_selection_policies (version,policy_json) VALUES (1,'{"keep":"policy"}')`;
        const projectBefore = (yield* sql`SELECT * FROM projection_projects`)[0]!;
        const threadBefore = (yield* sql`SELECT * FROM projection_threads`)[0]!;
        const ownersBefore = yield* sql`SELECT * FROM custom_workers`;
        const policiesBefore = yield* sql`SELECT * FROM model_selection_policies`;
        yield* runMigrations({ toMigrationInclusive: 68 });
        expect((yield* sql`SELECT p.* FROM projection_projects p`)[0]).toEqual({
          ...projectBefore,
          base_prompt: null,
        });
        expect((yield* sql`SELECT t.* FROM projection_threads t`)[0]).toEqual({
          ...threadBefore,
          is_base: "false",
        });
        yield* sql`UPDATE projection_projects SET base_prompt = 'Keep this custom prompt' WHERE project_id = 'project'`;
        yield* sql`UPDATE projection_threads SET is_base = 'true' WHERE thread_id = 'source'`;
        yield* sql`INSERT INTO base_session_submissions (request_id,input_json,source_id,thread_id,state) VALUES ('request','{}','source','fork','cloning')`;
        const receipt = yield* sql`SELECT * FROM base_session_submissions`;
        yield* runMigrations();
        expect(yield* sql`SELECT * FROM session_workspaces`).toEqual([]);
        expect(yield* sql`SELECT * FROM base_session_submissions`).toEqual(receipt);
        expect(yield* sql`SELECT * FROM custom_workers`).toEqual(ownersBefore);
        expect(yield* sql`SELECT * FROM model_selection_policies`).toEqual(policiesBefore);
        expect((yield* sql`SELECT p.* FROM projection_projects p`)[0]).toEqual({
          ...projectBefore,
          base_prompt: "Keep this custom prompt",
        });
        expect((yield* sql`SELECT t.* FROM projection_threads t`)[0]).toEqual({
          ...threadBefore,
          is_base: "true",
        });
        expect(
          yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id > 67 ORDER BY migration_id`,
        ).toEqual([
          { migration_id: 68, name: "BaseSessions" },
          { migration_id: 69, name: "SessionWorkspaces" },
        ]);
        yield* sql`INSERT INTO session_workspaces (reservation_id,thread_id,binding_json,state,active) VALUES ('first','fork','{}','reserved',1)`;
        expect(
          (yield* sql`INSERT INTO session_workspaces (reservation_id,thread_id,binding_json,state,active) VALUES ('duplicate','fork','{}','reserved',1)`.pipe(
            Effect.result,
          ))._tag,
        ).toBe("Failure");
        yield* runMigrations();
        expect(yield* sql`SELECT * FROM base_session_submissions`).toEqual(receipt);
        expect(yield* sql`SELECT * FROM session_workspaces`).toHaveLength(1);
      }),
  );
});
