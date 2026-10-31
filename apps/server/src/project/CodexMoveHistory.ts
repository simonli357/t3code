// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import * as Files from "./SessionMoveFiles.ts";

const Id = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i));
const Ordinal = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const Header = Schema.Struct({
  type: Schema.Literal("session_meta"),
  payload: Schema.Struct({
    id: Id,
    history_mode: Schema.optional(Schema.Literals(["legacy", "paginated"])),
    history_base: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          thread_id: Id,
          end_ordinal_exclusive: Ordinal,
          end_byte_offset: Ordinal,
        }),
      ),
    ),
    forked_from_id: Schema.optional(Schema.NullOr(Id)),
    forked_from_ordinal_exclusive: Schema.optional(Schema.NullOr(Ordinal)),
  }),
});
const decodeHeader = Schema.decodeUnknownSync(Schema.fromJsonString(Header));
export const CodexMoveRollout = Schema.Struct({
  id: Id,
  name: Schema.String,
  bytes: Schema.optional(Ordinal),
});
type Rollout = typeof CodexMoveRollout.Type;

async function indexRollouts(home: string) {
  const found = new Map<string, string[]>();
  const walk = async (directory: string, depth: number): Promise<void> => {
    const entries = await NodeFSP.readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const path = NodePath.join(directory, entry.name);
      if (entry.isDirectory() && depth) await walk(path, depth - 1);
      if (!entry.isFile()) continue;
      const id = /^rollout-.+-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i.exec(
        entry.name,
      )?.[1];
      if (id)
        found.set(id, [
          ...(found.get(id) ?? []),
          NodePath.relative(home, path).replaceAll("\\", "/"),
        ]);
    }
  };
  for (const [name, depth] of [
    ["sessions", 3],
    ["archived_sessions", 0],
  ] as const) {
    const root = NodePath.join(home, name);
    const info = await NodeFSP.lstat(root).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error("Codex move history cannot follow symlinks.");
    if (info?.isDirectory()) await walk(root, depth);
  }
  return found;
}

async function header(path: string) {
  const file = await NodeFSP.open(path, "r");
  try {
    const parts: Buffer[] = [];
    for (let offset = 0; offset < 8 * 1024 * 1024;) {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      const end = buffer.subarray(0, bytesRead).indexOf(10);
      parts.push(buffer.subarray(0, end < 0 ? bytesRead : end));
      if (end >= 0) return decodeHeader(Buffer.concat(parts).toString("utf8")).payload;
      if (!bytesRead) break;
      offset += bytesRead;
    }
    throw new Error("Missing or oversized session metadata line.");
  } catch (cause) {
    throw new Error(`Malformed Codex move lineage in ${path}: ${String(cause)}`, { cause });
  } finally {
    await file.close();
  }
}

export async function captureCodexMoveHistory(
  home: string,
  nativeIds: readonly string[],
): Promise<Rollout[]> {
  const index = await indexRollouts(home);
  const found = new Map<string, Rollout>();
  const cutoffs = new Map<string, number>();
  const paginated = new Set<string>();
  const visiting = new Set<string>();
  const visit = async (id: string, referenced = false): Promise<void> => {
    if (visiting.has(id)) throw new Error(`Codex move lineage contains a cycle at ${id}.`);
    if (found.has(id)) {
      if (referenced && !paginated.has(id))
        throw new Error(`Invalid Codex move lineage metadata for ${id}.`);
      return;
    }
    if (found.size + visiting.size >= 512)
      throw new Error("Codex move lineage exceeds 512 rollouts.");
    const names = index.get(id) ?? [];
    if (names.length !== 1)
      throw new Error(
        `Codex move lineage ${id}: ${names.length ? "multiple rollout copies" : "missing source rollout"}.`,
      );
    const name = names[0]!;
    const meta = await header(Files.contained(home, name));
    if (meta.history_mode === "paginated") paginated.add(id);
    if ((!referenced && meta.id !== id) || (referenced && meta.history_mode !== "paginated"))
      throw new Error(`Invalid Codex move lineage metadata for ${id}.`);
    visiting.add(id);
    const base = meta.history_base;
    if (base) {
      if (
        meta.history_mode !== "paginated" ||
        !base.end_ordinal_exclusive ||
        !Number.isSafeInteger(base.end_ordinal_exclusive) ||
        !Number.isSafeInteger(base.end_byte_offset)
      )
        throw new Error(`Invalid Codex move lineage cutoff for ${id}.`);
      await visit(base.thread_id, true);
      cutoffs.set(base.thread_id, Math.max(cutoffs.get(base.thread_id) ?? 0, base.end_byte_offset));
      const source = Files.contained(home, found.get(base.thread_id)!.name);
      const file = await NodeFSP.open(source, "r");
      try {
        const byte = Buffer.alloc(1);
        if (
          base.end_byte_offset < 1 ||
          (await file.stat()).size < base.end_byte_offset ||
          (await file.read(byte, 0, 1, base.end_byte_offset - 1)).bytesRead !== 1 ||
          byte[0] !== 10
        )
          throw new Error(`Codex move lineage ${id}: cutoff is outside complete source history.`);
      } finally {
        await file.close();
      }
    }
    visiting.delete(id);
    found.set(id, { id, name });
  };
  for (const id of nativeIds) await visit(id);
  return [...found.values()].map((entry) => ({
    ...entry,
    ...(nativeIds.includes(entry.id) ? {} : { bytes: cutoffs.get(entry.id)! }),
  }));
}

async function containsHistory(source: string, destination: string, bytes: number) {
  const from = await NodeFSP.open(source, "r");
  const to = await NodeFSP.open(destination, "r");
  try {
    const size = bytes;
    if ((await from.stat()).size < size) return false;
    if ((await to.stat()).size < size) return false;
    for (let offset = 0; offset < size;) {
      const length = Math.min(512 * 1024, size - offset);
      const a = Buffer.alloc(length),
        b = Buffer.alloc(length);
      const left = await from.read(a, 0, length, offset),
        right = await to.read(b, 0, length, offset);
      if (left.bytesRead !== length || right.bytesRead !== length || !a.equals(b)) return false;
      offset += length;
    }
    return true;
  } finally {
    await from.close();
    await to.close();
  }
}

export async function installCodexMoveHistory(
  staging: string,
  home: string,
  nativeIds: readonly string[],
  files: readonly Files.MoveFile[],
  replaceParked: boolean,
) {
  const source = NodePath.join(staging, "native");
  const rollouts = await captureCodexMoveHistory(source, nativeIds);
  const native = files.filter((file) => file.kind === "native");
  if (
    native.length !== rollouts.length ||
    native.some((file) => !rollouts.some((entry) => entry.name === file.name))
  )
    throw new Error("Codex move contains unrelated or missing history rollouts.");
  const existing = await indexRollouts(home);
  const preserved = new Set<string>();
  for (const entry of rollouts.filter((entry) => !nativeIds.includes(entry.id))) {
    const matches = existing.get(entry.id) ?? [];
    if (!matches.length) continue;
    if (
      matches.length !== 1 ||
      !(await containsHistory(
        Files.contained(source, entry.name),
        Files.contained(home, matches[0]!),
        entry.bytes!,
      ))
    )
      throw new Error(
        `Destination Codex ancestor ${entry.id} conflicts with captured history; preserve both copies.`,
      );
    preserved.add(entry.name);
  }
  for (const entry of rollouts) {
    if (preserved.has(entry.name)) continue;
    const file = native.find((file) => file.name === entry.name)!;
    await Files.installMoveFile(
      staging,
      file,
      home,
      file.name,
      nativeIds.includes(entry.id) && replaceParked,
    );
  }
}
