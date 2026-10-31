// @effect-diagnostics nodeBuiltinImport:off
import { afterEach, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { captureCodexMoveHistory, installCodexMoveHistory } from "./CodexMoveHistory.ts";
import * as Files from "./SessionMoveFiles.ts";

const ids = [1, 2, 3, 4, 5].map((n) => `019b1111-2222-7333-8444-55555555555${n}`);
const [base, fork, leaf, child, sibling] = ids as [string, string, string, string, string];
const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await NodeFSP.rm(path, { recursive: true, force: true });
});
async function home() {
  const path = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codex-move-lineage-"));
  temporary.push(path);
  return path;
}
const name = (id: string) => `sessions/2026/10/28/rollout-2026-10-28T12-00-00-${id}.jsonl`;
async function rollout(home: string, id: string, parent?: string) {
  const parentBytes = parent ? (await NodeFSP.stat(Files.contained(home, name(parent)))).size : 0;
  const data =
    JSON.stringify({
      type: "session_meta",
      payload: {
        id,
        history_mode: "paginated",
        ...(parent
          ? {
              forked_from_id: parent,
              forked_from_ordinal_exclusive: 4,
              history_base: {
                thread_id: parent,
                end_ordinal_exclusive: 4,
                end_byte_offset: parentBytes,
              },
            }
          : {}),
      },
    }) + "\n";
  const path = Files.contained(home, name(id));
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSP.writeFile(path, data);
  return data;
}
async function stage(source: string, nativeIds: string[]) {
  const staging = await home();
  const entries = await captureCodexMoveHistory(source, nativeIds);
  const files = await Promise.all(
    entries.map((entry) =>
      Files.copyMoveFile({
        source: Files.contained(source, entry.name),
        sourceRoot: source,
        staging,
        kind: "native",
        name: entry.name,
        ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }),
      }),
    ),
  );
  return { staging, files };
}

it("captures nested and shared ancestry for the family without siblings, and preserves a longer archived ancestor on retry", async () => {
  const source = await home(),
    destination = await home();
  const original = await rollout(source, base);
  await rollout(source, fork, base);
  await rollout(source, leaf, fork);
  await rollout(source, child, base);
  await rollout(source, sibling, base);
  expect((await captureCodexMoveHistory(source, [leaf, child])).map((entry) => entry.id)).toEqual([
    base,
    fork,
    leaf,
    child,
  ]);
  const archived = Files.contained(
    destination,
    "archived_sessions/" + NodePath.basename(name(base)),
  );
  await NodeFSP.mkdir(NodePath.dirname(archived));
  await NodeFSP.writeFile(
    archived,
    original + '{"type":"event_msg","payload":{"type":"task_complete"}}\n',
  );
  const before = await NodeFSP.readFile(archived);
  const { staging, files } = await stage(source, [leaf, child]);
  for (let i = 0; i < 2; i++)
    await installCodexMoveHistory(staging, destination, [leaf, child], files, true);
  expect(await NodeFSP.readFile(archived)).toEqual(before);
  expect(await NodeFSP.stat(Files.contained(destination, name(base))).catch(() => null)).toBeNull();
  expect(
    (await captureCodexMoveHistory(destination, [leaf, child])).map((entry) => entry.id),
  ).toEqual([base, fork, leaf, child]);
  expect(
    await NodeFSP.stat(Files.contained(destination, name(sibling))).catch(() => null),
  ).toBeNull();
});

it("rejects a conflicting or shorter ancestor before installing the moved thread, even on a retry", async () => {
  const source = await home(),
    destination = await home();
  const original = await rollout(source, base);
  await rollout(source, leaf, base);
  const { staging, files } = await stage(source, [leaf]);
  await rollout(destination, base);
  for (const conflict of [original.replace("paginated", "different"), original.slice(0, -1)]) {
    await NodeFSP.writeFile(Files.contained(destination, name(base)), conflict);
    await expect(
      installCodexMoveHistory(staging, destination, [leaf], files, true),
    ).rejects.toThrow("ancestor " + base + " conflicts");
    expect(await NodeFSP.readFile(Files.contained(destination, name(base)), "utf8")).toBe(conflict);
    expect(
      await NodeFSP.stat(Files.contained(destination, name(leaf))).catch(() => null),
    ).toBeNull();
  }
});

it("copies the maximum shared cutoff and preserves different shorter destination continuations", async () => {
  const source = await home(),
    destination = await home();
  const first = await rollout(source, base);
  await rollout(source, leaf, base);
  const shared = first + '{"type":"event_msg","payload":{"type":"task_complete"}}\n';
  await NodeFSP.writeFile(Files.contained(source, name(base)), shared);
  await rollout(source, child, base);
  await NodeFSP.appendFile(
    Files.contained(source, name(base)),
    '{"type":"event_msg","payload":{"type":"source_only_long_continuation"}}\n',
  );
  const { staging, files } = await stage(source, [leaf, child]);
  expect(
    await NodeFSP.readFile(Files.contained(NodePath.join(staging, "native"), name(base)), "utf8"),
  ).toBe(shared);
  await rollout(destination, base);
  const continuation = shared + '{"different":true}\n';
  await NodeFSP.writeFile(Files.contained(destination, name(base)), continuation);
  for (let attempt = 0; attempt < 2; attempt++) {
    await installCodexMoveHistory(staging, destination, [leaf, child], files, true);
    expect(await NodeFSP.readFile(Files.contained(destination, name(base)), "utf8")).toBe(
      continuation,
    );
  }
  expect(await NodeFSP.readFile(Files.contained(destination, name(leaf)), "utf8")).toBe(
    await NodeFSP.readFile(Files.contained(source, name(leaf)), "utf8"),
  );
});

it("fails clearly for missing, malformed, cyclic, and truncated lineage before transfer", async () => {
  const source = await home();
  const original = await rollout(source, base);
  await rollout(source, leaf, base);
  await NodeFSP.unlink(Files.contained(source, name(base)));
  await expect(captureCodexMoveHistory(source, [leaf])).rejects.toThrow("missing source rollout");
  await NodeFSP.writeFile(Files.contained(source, name(base)), "not json\n");
  await expect(captureCodexMoveHistory(source, [leaf])).rejects.toThrow(
    "Malformed Codex move lineage",
  );
  await NodeFSP.writeFile(Files.contained(source, name(base)), original);
  await rollout(source, base, leaf);
  await expect(captureCodexMoveHistory(source, [leaf])).rejects.toThrow("cycle");
  await NodeFSP.writeFile(Files.contained(source, name(base)), original.slice(0, -1));
  await expect(captureCodexMoveHistory(source, [leaf])).rejects.toThrow(
    "Malformed Codex move lineage",
  );
  await NodeFSP.writeFile(
    Files.contained(source, name(base)),
    original.replace(',"history_mode":"paginated"', "") + "\n",
  );
  await expect(captureCodexMoveHistory(source, [leaf])).rejects.toThrow(
    "Invalid Codex move lineage metadata",
  );
});
