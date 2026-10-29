// @effect-diagnostics nodeBuiltinImport:off
import { afterEach, expect, it } from "vite-plus/test";
import * as NodeSqlite from "node:sqlite";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  captureCodexMoveState,
  codexRolloutName,
  decodeCodexMoveState,
  installCodexMoveState,
} from "./CodexMoveState.ts";

const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await NodeFSP.rm(directory, { recursive: true, force: true });
});
const main = "019b1111-2222-7333-8444-555555555555";
const child = "019b1111-2222-7333-8444-666666666666";
const unrelated = "019b1111-2222-7333-8444-777777777777";
async function home() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-move-native-state-"));
  temporary.push(directory);
  const state = new NodeSqlite.DatabaseSync(NodePath.join(directory, "state_5.sqlite"));
  state.exec(
    "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, archived INTEGER, archived_at INTEGER, project_id TEXT, thread_section_id TEXT, model TEXT); CREATE TABLE thread_dynamic_tools (thread_id TEXT, position INTEGER, description TEXT, PRIMARY KEY(thread_id,position)); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT, PRIMARY KEY(parent_thread_id,child_thread_id)); CREATE TABLE credentials (token TEXT);",
  );
  state.prepare("INSERT INTO credentials VALUES (?)").run("never-export-me");
  state.close();
  const goals = new NodeSqlite.DatabaseSync(NodePath.join(directory, "goals_1.sqlite"));
  goals.exec(
    "CREATE TABLE thread_goals(thread_id TEXT PRIMARY KEY, objective TEXT, token_budget INTEGER, tokens_used INTEGER)",
  );
  goals.close();
  return directory;
}
it("moves only the selected native family, dynamic tools and goal budgets, leaving other conversations and credentials intact", async () => {
  const source = await home();
  const destination = await home();
  const state = new NodeSqlite.DatabaseSync(NodePath.join(source, "state_5.sqlite"));
  for (const id of [main, child, unrelated]) {
    const rollout = NodePath.join(
      source,
      "sessions/2026/10/22/rollout-2026-10-22T12-00-00-" + id + ".jsonl",
    );
    await NodeFSP.mkdir(NodePath.dirname(rollout), { recursive: true });
    await NodeFSP.writeFile(
      rollout,
      JSON.stringify({ type: "session_meta", payload: { id, history_mode: "paginated" } }) + "\n",
    );
    state
      .prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)")
      .run(
        id,
        NodePath.join(source, "sessions/2026/10/22/rollout-2026-10-22T12-00-00-" + id + ".jsonl"),
        source,
        1,
        100,
        "source-project",
        "source-group",
        "gpt-6.1-sol",
      );
    state.prepare("INSERT INTO thread_dynamic_tools VALUES (?,?,?)").run(id, 0, "tool-for-" + id);
  }
  state.prepare("INSERT INTO thread_spawn_edges VALUES (?,?,?)").run(main, child, "completed");
  state.close();
  const ancestor = NodePath.join(
    source,
    "sessions/2026/10/22/rollout-2026-10-22T12-00-00-" + unrelated + ".jsonl",
  );
  await NodeFSP.writeFile(
    NodePath.join(source, "sessions/2026/10/22/rollout-2026-10-22T12-00-00-" + main + ".jsonl"),
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: main,
        history_mode: "paginated",
        history_base: {
          thread_id: unrelated,
          end_ordinal_exclusive: 1,
          end_byte_offset: (await NodeFSP.stat(ancestor)).size,
        },
      },
    }) + "\n",
  );
  const goals = new NodeSqlite.DatabaseSync(NodePath.join(source, "goals_1.sqlite"));
  goals
    .prepare("INSERT INTO thread_goals VALUES (?,?,?,?)")
    .run(main, "finish the same objective", 4000, 1700);
  goals.close();
  const exported = await captureCodexMoveState(source, main);
  expect(exported.nativeIds).toEqual([main, child]);
  expect(JSON.stringify(exported)).not.toContain("never-export-me");
  expect(JSON.stringify(exported.databases)).not.toContain(unrelated);
  expect(exported.rollouts?.map((entry) => entry.id)).toEqual([unrelated, main, child]);
  expect(codexRolloutName(exported, main)).toBe(
    "sessions/2026/10/22/rollout-2026-10-22T12-00-00-" + main + ".jsonl",
  );
  const target = new NodeSqlite.DatabaseSync(NodePath.join(destination, "state_5.sqlite"));
  target
    .prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?)")
    .run(unrelated, "keep-path", "keep-cwd", 0, null, "keep-project", null, "keep-model");
  target.close();
  await installCodexMoveState(
    destination,
    "/new/workspace",
    decodeCodexMoveState(JSON.stringify(exported)),
  );
  // A retry converges without duplicating tools, edges, or goals.
  await installCodexMoveState(destination, "/new/workspace", exported);
  const read = new NodeSqlite.DatabaseSync(NodePath.join(destination, "state_5.sqlite"), {
    readOnly: true,
  });
  expect(
    read.prepare("SELECT cwd, archived, project_id FROM threads WHERE id = ?").get(main),
  ).toMatchObject({ cwd: "/new/workspace", archived: 0, project_id: null });
  expect(read.prepare("SELECT cwd FROM threads WHERE id = ?").get(unrelated)).toMatchObject({
    cwd: "keep-cwd",
  });
  expect(read.prepare("SELECT COUNT(*) AS n FROM thread_dynamic_tools").get()!.n).toBe(2);
  expect(read.prepare("SELECT token FROM credentials").get()!.token).toBe("never-export-me");
  read.close();
  const readGoal = new NodeSqlite.DatabaseSync(NodePath.join(destination, "goals_1.sqlite"), {
    readOnly: true,
  });
  expect(
    readGoal.prepare("SELECT * FROM thread_goals WHERE thread_id = ?").get(main),
  ).toMatchObject({
    objective: "finish the same objective",
    token_budget: 4000,
    tokens_used: 1700,
  });
  readGoal.close();
});
it("refuses incompatible native schemas and unrelated rows without partially changing a database", async () => {
  const destination = await home();
  const invalid = {
    nativeIds: [main],
    databases: [
      { name: "state_5.sqlite", tables: [{ name: "threads", columns: ["id"], rows: [[main]] }] },
    ],
  };
  await expect(installCodexMoveState(destination, "/new/workspace", invalid)).rejects.toThrow(
    "schemas differ",
  );
  const database = new NodeSqlite.DatabaseSync(NodePath.join(destination, "state_5.sqlite"), {
    readOnly: true,
  });
  expect(database.prepare("SELECT COUNT(*) AS n FROM threads").get()!.n).toBe(0);
  database.close();
  await expect(
    installCodexMoveState(destination, "/new/workspace", {
      nativeIds: [main],
      databases: [{ name: "../auth.sqlite", tables: [] }],
    }),
  ).rejects.toThrow("database name");
});
