// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { git } from "../project/SessionMoveFiles.ts";
import type { SessionWorkspace } from "./SessionWorkspaces.ts";

const receipt = (job: SessionWorkspace) => NodePath.join(job.root, "source-snapshot.json");
const identity = (job: SessionWorkspace) =>
  JSON.stringify({
    jobId: job.jobId,
    sourceDirectory: job.sourceDirectory,
    sourceKind: job.sourceKind,
  });
const exists = (file: string) =>
  NodeFSP.stat(file).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    },
  );

export async function verifySourceSnapshot(job: SessionWorkspace) {
  if ((await NodeFSP.readFile(receipt(job), "utf8")) !== identity(job))
    throw new Error("Workspace snapshot does not match its reserved source.");
}

const within = (root: string, candidate: string) => {
  const relative = NodePath.relative(root, candidate);
  return (
    relative !== ".." && !relative.startsWith(".." + NodePath.sep) && !NodePath.isAbsolute(relative)
  );
};

async function copyInputs(source: string, destination: string, workRoot: string) {
  const sourceRoot = await NodeFSP.realpath(source);
  const excludedRoot = await NodeFSP.realpath(workRoot);
  if (within(excludedRoot, sourceRoot))
    throw new Error("Snapshot source resolves inside the agent work root.");
  const copy = async (from: string, to: string, ancestors: ReadonlyArray<string>) => {
    if (NodePath.basename(from).toLowerCase() === ".git") return;
    const resolved = await NodeFSP.realpath(from).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ELOOP") return null;
      throw error;
    });
    if (resolved === null || within(excludedRoot, resolved)) return;
    if (!within(sourceRoot, resolved))
      throw new Error(`Snapshot input links outside its source directory: ${from}`);
    if (
      NodePath.relative(sourceRoot, resolved)
        .split(NodePath.sep)
        .some((part) => part.toLowerCase() === ".git")
    )
      return;
    const stat = await NodeFSP.stat(resolved);
    if (stat.isDirectory()) {
      if (ancestors.some((ancestor) => NodePath.relative(ancestor, resolved) === "")) return;
      await NodeFSP.mkdir(to);
      for (const entry of await NodeFSP.readdir(resolved))
        await copy(NodePath.join(resolved, entry), NodePath.join(to, entry), [
          ...ancestors,
          resolved,
        ]);
    } else if (stat.isFile()) {
      await NodeFSP.copyFile(resolved, to);
    } else {
      throw new Error(`Snapshot input is not a regular file or directory: ${from}`);
    }
  };
  // Walk selected entries rather than asking fs.cp to copy into a descendant.
  // Junction targets become independent copies, never links back to the input.
  await copy(sourceRoot, destination, []);
}

/** Copy inputs once; neither an ordinary source nor an unborn source is modified. */
export async function prepareSourceSnapshot(job: SessionWorkspace) {
  const staged = NodePath.join(job.tmpDirectory, "source-snapshot");
  if (await exists(job.workspaceDirectory)) {
    await verifySourceSnapshot(job);
    return;
  }
  if (await exists(receipt(job))) {
    await verifySourceSnapshot(job);
  } else {
    // Retain an interrupted copy for inspection instead of merging a changed
    // source into partially copied files. A completed copy is never refreshed.
    if (await exists(staged))
      await NodeFSP.rename(staged, staged + "-incomplete-" + NodeCrypto.randomUUID());
    await copyInputs(job.sourceDirectory, staged, NodePath.dirname(job.root));
    if (job.sourceKind === "unborn") await git(staged, ["init", "--initial-branch=" + job.branch]);
    await NodeFSP.writeFile(receipt(job), identity(job), { flag: "wx" });
  }
  await NodeFSP.rename(staged, job.workspaceDirectory);
}
