// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeStreamPromises from "node:stream/promises";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
export const MOVE_CHUNK_BYTES = 512 * 1024;
const MAX_MOVE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_MOVE_FILES = 20_000;
export interface MoveFile {
  readonly name: string;
  readonly kind: "native" | "attachment" | "workspace" | "history";
  readonly bytes: number;
  readonly sha256: string;
  readonly executable: boolean;
}
export interface MoveWorkspace {
  readonly head: string;
  readonly origin: string | null;
  readonly branch: string | null;
}
export const moveDirectory = (stateDir: string, id: string) =>
  NodePath.join(
    stateDir,
    "session-moves",
    NodeCrypto.createHash("sha256").update(id).digest("hex"),
  );
export const moveBranch = (id: string) =>
  "t3-moved/" + NodeCrypto.createHash("sha256").update(id).digest("hex").slice(0, 16);

export function contained(root: string, name: string): string {
  if (
    !name ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.startsWith("/") ||
    name.split("/").some((part) => !part || part === "." || part === "..") ||
    name.includes(":")
  )
    throw new Error("Invalid session-transfer file NodePath.");
  const resolved = NodePath.resolve(root, name);
  if (!resolved.startsWith(NodePath.resolve(root) + NodePath.sep))
    throw new Error("Transfer path escapes its directory.");
  return resolved;
}
export async function digestFile(file: string, bytes?: number): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(
    file,
    bytes === undefined ? {} : { end: bytes - 1 },
  ))
    hash.update(chunk);
  return hash.digest("hex");
}
async function noLinks(file: string, root: string, allowMissing = false): Promise<void> {
  const relative = NodePath.relative(root, file);
  if (relative.startsWith("..") || NodePath.isAbsolute(relative))
    throw new Error("File is outside its allowed root.");
  let current = root;
  for (const part of ["", ...relative.split(NodePath.sep).filter(Boolean)]) {
    current = NodePath.join(current, part);
    const info = await NodeFSP.lstat(current).catch((error) => {
      if (allowMissing && error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error("Session transfers do not follow symlinks.");
  }
}
export async function copyMoveFile(input: {
  source: string;
  sourceRoot: string;
  staging: string;
  kind: MoveFile["kind"];
  name: string;
  bytes?: number;
}): Promise<MoveFile> {
  await noLinks(input.source, input.sourceRoot);
  const before = await NodeFSP.stat(input.source);
  if (!before.isFile()) throw new Error("A transfer entry is not a regular file.");
  const destination = contained(NodePath.join(input.staging, input.kind), input.name);
  await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true, mode: 0o700 });
  if (input.bytes !== undefined) {
    if (!Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > before.size)
      throw new Error("Invalid session history prefix length.");
    await NodeStreamPromises.pipeline(
      NodeFS.createReadStream(input.source, { end: input.bytes - 1 }),
      NodeFS.createWriteStream(destination, { mode: 0o600 }),
    );
  } else await NodeFSP.copyFile(input.source, destination);
  const after = await NodeFSP.stat(input.source);
  const sha256 = await digestFile(destination);
  if (
    input.bytes !== undefined
      ? after.size < input.bytes ||
        (await NodeFSP.stat(destination)).size !== input.bytes ||
        (await digestFile(input.source, input.bytes)) !== sha256
      : before.size !== after.size || before.mtimeMs !== after.mtimeMs
  )
    throw new Error("A session file changed during capture. Retry after its turn has stopped.");
  return {
    name: input.name,
    kind: input.kind,
    bytes: input.bytes ?? before.size,
    sha256,
    executable: (before.mode & 0o111) !== 0,
  };
}
export async function listMoveFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string) {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const file = NodePath.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("A session sidecar contains a symlink.");
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) found.push(file);
      if (found.length > MAX_MOVE_FILES) throw new Error("Session transfer has too many files.");
    }
  }
  await walk(root);
  return found;
}
export function validateMoveFiles(files: ReadonlyArray<MoveFile>): void {
  const keys = new Set<string>();
  let total = 0;
  for (const file of files) {
    contained("/transfer", file.name);
    const key = file.kind + ":" + file.name;
    if (
      keys.has(key) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    )
      throw new Error("Invalid transfer manifest.");
    keys.add(key);
    total += file.bytes;
  }
  if (files.length > MAX_MOVE_FILES || total > MAX_MOVE_BYTES)
    throw new Error("Session transfer exceeds its file/size budget.");
}
export async function readMoveChunk(staging: string, file: MoveFile, offset: number) {
  const handle = await NodeFSP.open(contained(NodePath.join(staging, file.kind), file.name), "r");
  try {
    const buffer = Buffer.alloc(Math.min(MOVE_CHUNK_BYTES, Math.max(0, file.bytes - offset)));
    const read = await handle.read(buffer, 0, buffer.length, offset);
    return buffer.subarray(0, read.bytesRead).toString("base64");
  } finally {
    await handle.close();
  }
}
export async function writeMoveChunk(
  staging: string,
  file: MoveFile,
  offset: number,
  data: string,
) {
  const bytes = Buffer.from(data, "base64");
  if (
    bytes.length > MOVE_CHUNK_BYTES ||
    offset < 0 ||
    !Number.isSafeInteger(offset) ||
    offset + bytes.length > file.bytes ||
    (bytes.length === 0 && offset !== file.bytes)
  )
    throw new Error("Invalid session-transfer chunk.");
  const target = contained(NodePath.join(staging, file.kind), file.name);
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true, mode: 0o700 });
  const handle = await NodeFSP.open(target, offset === 0 ? "w" : "r+");
  try {
    if ((await handle.stat()).size < offset) throw new Error("Session-transfer chunk has a gap.");
    await handle.write(bytes, 0, bytes.length, offset);
  } finally {
    await handle.close();
  }
}
export async function verifyMoveFiles(staging: string, files: ReadonlyArray<MoveFile>) {
  validateMoveFiles(files);
  for (const file of files) {
    const target = contained(NodePath.join(staging, file.kind), file.name);
    await noLinks(target, staging);
    if (
      (await NodeFSP.stat(target)).size !== file.bytes ||
      (await digestFile(target)) !== file.sha256
    )
      throw new Error("A copied session file failed verification.");
  }
}
export async function installMoveFile(
  staging: string,
  file: MoveFile,
  root: string,
  name = file.name,
  replaceParked = false,
) {
  const target = contained(root, name);
  await noLinks(NodePath.dirname(target), root, true);
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true, mode: 0o700 });
  await noLinks(NodePath.dirname(target), root);
  try {
    const info = await NodeFSP.lstat(target);
    if (!info.isFile() || (!replaceParked && (await digestFile(target)) !== file.sha256))
      throw new Error("The destination already contains different session data.");
    if ((await digestFile(target)) !== file.sha256) {
      const temporary = target + ".session-move-" + file.sha256.slice(0, 16);
      await NodeFSP.copyFile(contained(NodePath.join(staging, file.kind), file.name), temporary);
      await NodeFSP.chmod(temporary, file.executable ? 0o700 : 0o600);
      await NodeFSP.rename(temporary, target);
    }
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await NodeFSP.copyFile(contained(NodePath.join(staging, file.kind), file.name), target, 1);
  await NodeFSP.chmod(target, file.executable ? 0o700 : 0o600);
}
export async function git(cwd: string, args: ReadonlyArray<string>) {
  const result = await execute("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout;
}
export async function verifyClaudeMove(
  executable: string,
  workerArgs: ReadonlyArray<string>,
  home: string,
  cwd: string,
  nativeId: string,
) {
  const result = await execute(
    executable,
    [...workerArgs, "getSessionInfo", nativeId, JSON.stringify({ dir: cwd })],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      env: { ...process.env, CLAUDE_CONFIG_DIR: home, ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  const info = JSON.parse(result.stdout || "null") as { sessionId?: string } | null;
  if (info?.sessionId !== nativeId)
    throw new Error("Claude could not find the copied native session at its destination.");
}
export async function inspectMoveWorkspace(cwd: string): Promise<MoveWorkspace> {
  const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  if (!/^[0-9a-f]{40,64}$/.test(head))
    throw new Error("A session move needs a committed Git workspace.");
  return {
    head,
    origin: await git(cwd, ["config", "--get", "remote.origin.url"])
      .then((value) => value.trim())
      .catch(() => null),
    branch: await git(cwd, ["symbolic-ref", "--short", "HEAD"])
      .then((value) => value.trim())
      .catch(() => null),
  };
}
export async function captureMoveWorkspace(
  cwd: string,
  staging: string,
  bundle: boolean,
  threadId?: string,
): Promise<MoveFile[]> {
  const generated = NodePath.join(staging, "generated");
  await NodeFSP.mkdir(generated, { recursive: true, mode: 0o700 });
  const files: MoveFile[] = [];
  for (const [name, args] of [
    ["staged.patch", ["diff", "--binary", "--cached", "--no-ext-diff"]],
    ["working.patch", ["diff", "--binary", "--no-ext-diff"]],
  ] as const) {
    const text = await git(cwd, args);
    const source = NodePath.join(generated, name);
    await NodeFSP.writeFile(source, text, { mode: 0o600 });
    files.push(
      await copyMoveFile({ source, sourceRoot: generated, staging, kind: "workspace", name }),
    );
  }
  if (bundle) {
    const source = NodePath.join(generated, "source.bundle");
    await git(cwd, ["bundle", "create", source, "HEAD"]);
    files.push(
      await copyMoveFile({
        source,
        sourceRoot: generated,
        staging,
        kind: "workspace",
        name: "source.bundle",
      }),
    );
  }
  if (threadId) {
    const prefix = "refs/t3/checkpoints/" + Buffer.from(threadId).toString("base64url") + "/";
    const refs = (await git(cwd, ["for-each-ref", "--format=%(refname)", prefix]))
      .trim()
      .split("\n")
      .filter(Boolean);
    if (refs.length) {
      const source = NodePath.join(generated, "checkpoints.bundle");
      await git(cwd, ["bundle", "create", source, ...refs]);
      files.push(
        await copyMoveFile({
          source,
          sourceRoot: generated,
          staging,
          kind: "workspace",
          name: "checkpoints.bundle",
        }),
      );
    }
  }
  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean);
  for (const name of untracked)
    files.push(
      await copyMoveFile({
        source: contained(cwd, name),
        sourceRoot: cwd,
        staging,
        kind: "workspace",
        name: "untracked/" + name,
      }),
    );
  return files;
}
/** Preserve the inactive local incarnation before a verified move returns. */
export async function parkReturningWorkspace(
  cwd: string,
  root: string,
  staging: string,
  requestId: string,
) {
  const saved = contained(NodePath.join(root, "previous"), requestId);
  const marker = NodePath.join(staging, "workspace-parked");
  const planFile = NodePath.join(staging, "workspace-parking.json");
  if (
    await NodeFSP.stat(marker).then(
      () => true,
      () => false,
    )
  )
    return;
  type ParkingPlan = {
    common: string;
    modules: Array<{ relative: string; gitDirectory: string; gitFile: boolean }>;
  };
  let plan: ParkingPlan;
  try {
    plan = JSON.parse(await NodeFSP.readFile(planFile, "utf8")) as ParkingPlan;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    plan = {
      common: NodePath.resolve(cwd, (await git(cwd, ["rev-parse", "--git-common-dir"])).trim()),
      modules: [],
    };
    const collect = async (directory: string) => {
      const entries = (await git(directory, ["ls-files", "--stage", "-z"])).split("\0");
      for (const entry of entries) {
        if (!entry.startsWith("160000 ")) continue;
        const module = contained(directory, entry.slice(entry.indexOf("\t") + 1));
        const metadata = await NodeFSP.stat(NodePath.join(module, ".git")).catch(
          (error: unknown) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
            throw error;
          },
        );
        if (!metadata) continue;
        plan.modules.push({
          relative: NodePath.relative(cwd, module).split(NodePath.sep).join("/"),
          gitDirectory: (await git(module, ["rev-parse", "--absolute-git-dir"])).trim(),
          gitFile: metadata.isFile(),
        });
        await collect(module);
      }
    };
    await collect(cwd);
    await NodeFSP.mkdir(staging, { recursive: true });
    await NodeFSP.writeFile(planFile, JSON.stringify(plan), { flag: "wx" });
  }
  if (
    !(await NodeFSP.stat(saved).then(
      () => true,
      () => false,
    ))
  ) {
    await NodeFSP.mkdir(NodePath.dirname(saved), { recursive: true });
    // Git refuses `worktree move` with initialized submodules. Rename intact,
    // then repair its backlinks and each submodule's relative gitfile/worktree.
    // The durable plan makes a crash between rename and repair recoverable.
    await NodeFSP.rename(cwd, saved);
  } else if (
    await NodeFSP.stat(cwd).then(
      () => true,
      () => false,
    )
  ) {
    throw new Error(
      "Returning workspace has both an unrecorded current and saved incarnation; inspect the retained move before retrying.",
    );
  }
  await git(NodePath.dirname(plan.common), ["worktree", "repair", saved]);
  for (const module of plan.modules) {
    const directory = contained(saved, module.relative);
    const relative = NodePath.relative(cwd, module.gitDirectory);
    const gitDirectory =
      relative !== ".." &&
      !relative.startsWith(".." + NodePath.sep) &&
      !NodePath.isAbsolute(relative)
        ? NodePath.join(saved, relative)
        : module.gitDirectory;
    if (module.gitFile) {
      // Git marks this file hidden on Windows; opening it with O_CREAT fails.
      const file = await NodeFSP.open(NodePath.join(directory, ".git"), "r+");
      try {
        const content = `gitdir: ${gitDirectory}\n`;
        await file.writeFile(content);
        await file.truncate(Buffer.byteLength(content));
      } finally {
        await file.close();
      }
    }
    await git(NodePath.dirname(plan.common), [
      "--git-dir=" + gitDirectory,
      "--work-tree=" + directory,
      "config",
      "core.worktree",
      directory,
    ]);
  }
  await NodeFSP.mkdir(staging, { recursive: true });
  await NodeFSP.writeFile(marker, "parked\n", { flag: "wx" });
}

export async function restoreMoveWorkspace(input: {
  projectRoot: string;
  cwd: string;
  staging: string;
  workspace: MoveWorkspace;
  files: ReadonlyArray<MoveFile>;
  requestId?: string;
  threadId?: string;
}) {
  const bundle = input.files.find(
    (file) => file.name === "source.bundle" && file.kind === "workspace",
  );
  if (bundle)
    await git(input.projectRoot, [
      "fetch",
      "--no-write-fetch-head",
      "--no-tags",
      contained(NodePath.join(input.staging, "workspace"), bundle.name),
      "HEAD",
    ]);
  try {
    await NodeFSP.stat(input.cwd);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    await NodeFSP.mkdir(NodePath.dirname(input.cwd), { recursive: true });
    await git(input.projectRoot, [
      "worktree",
      "add",
      ...(input.requestId ? ["-b", moveBranch(input.requestId)] : ["--detach"]),
      input.cwd,
      input.workspace.head,
    ]);
  }
  if ((await git(input.cwd, ["rev-parse", "HEAD"])).trim() !== input.workspace.head)
    throw new Error("The destination worktree changed during the session move.");
  const checkpoints = input.files.find(
    (file) => file.kind === "workspace" && file.name === "checkpoints.bundle",
  );
  if (checkpoints) {
    if (!input.threadId) throw new Error("A checkpoint bundle needs its session identifier.");
    const filename = contained(NodePath.join(input.staging, "workspace"), checkpoints.name);
    const prefix = "refs/t3/checkpoints/" + Buffer.from(input.threadId).toString("base64url") + "/";
    const refs = (await git(input.projectRoot, ["bundle", "list-heads", filename]))
      .trim()
      .split("\n")
      .map((line) => line.split(" ")[1]!);
    if (!refs.length || refs.some((ref) => !ref.startsWith(prefix)))
      throw new Error("Unrelated checkpoint in transfer.");
    await git(input.projectRoot, [
      "fetch",
      "--no-write-fetch-head",
      "--no-tags",
      filename,
      ...refs.map((ref) => "+" + ref + ":" + ref),
    ]);
  }
  // Restoration is idempotent only while the prepared worktree is private.
  const marker = NodePath.join(input.staging, "workspace-restored");
  try {
    await NodeFSP.stat(marker);
    return;
  } catch {
    /* first attempt */
  }
  for (const name of ["staged.patch", "working.patch"]) {
    const file = input.files.find((entry) => entry.kind === "workspace" && entry.name === name);
    if (file && file.bytes) {
      const patch = contained(NodePath.join(input.staging, "workspace"), name);
      const alreadyApplied = await git(input.cwd, [
        "apply",
        "--reverse",
        "--check",
        ...(name === "staged.patch" ? ["--cached"] : []),
        patch,
      ])
        .then(() => true)
        .catch(() => false);
      if (alreadyApplied) continue;
      await git(input.cwd, [
        "apply",
        "--binary",
        ...(name === "staged.patch" ? ["--index"] : []),
        contained(NodePath.join(input.staging, "workspace"), name),
      ]);
    }
  }
  for (const file of input.files.filter(
    (entry) => entry.kind === "workspace" && entry.name.startsWith("untracked/"),
  ))
    await installMoveFile(input.staging, file, input.cwd, file.name.slice("untracked/".length));
  await NodeFSP.writeFile(marker, "restored\n", { mode: 0o600 });
}
