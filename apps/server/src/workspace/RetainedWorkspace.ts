// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { workspaceEnvironment, type SessionWorkspace } from "./SessionWorkspaces.ts";

export function retainedWorkspaceEnvironment(
  threadId: string,
  cwd: string | undefined,
): Record<string, string> | undefined {
  if (!cwd || !NodePath.isAbsolute(cwd) || NodePath.basename(cwd).toLowerCase() !== "repo")
    return undefined;
  cwd = NodePath.normalize(cwd);
  const same = (left: unknown, right: string) =>
    typeof left === "string" &&
    (NodePath.sep === "\\"
      ? NodePath.normalize(left).toLowerCase() === NodePath.normalize(right).toLowerCase()
      : NodePath.normalize(left) === NodePath.normalize(right));
  const root = NodePath.dirname(cwd);
  const metadata = NodePath.join(root, ".workenv.json");
  if (!NodeFS.existsSync(metadata)) return undefined;
  const job = JSON.parse(NodeFS.readFileSync(metadata, "utf8"));
  if (job.identity?.[0] !== "t3" || job.status !== "released") return undefined;
  const fail = () => {
    throw new Error(
      `Retained workspace ${root} has stale or conflicting workenv metadata. Reconcile this exact released registration through workenv before resuming.`,
    );
  };
  const exact = (value: string) => same(NodeFS.realpathSync(value), value);
  const request = job.t3_registration;
  if (
    NodeFS.lstatSync(metadata).isSymbolicLink() ||
    !exact(root) ||
    !same(job.root, root) ||
    !same(job.repo, cwd) ||
    !same(job.relocated_to, root) ||
    !same(job.t3_relocation?.to, root) ||
    typeof job.t3_relocation?.from !== "string" ||
    NodeFS.existsSync(NodePath.join(job.t3_relocation.from, "repo")) ||
    NodeFS.existsSync(NodePath.join(job.t3_relocation.from, ".workenv.json")) ||
    !same(request?.root, root) ||
    !same(request?.workspaceDirectory, cwd) ||
    request?.jobId !== NodePath.basename(root).toLowerCase() ||
    request?.threadId !== threadId ||
    job.identity?.[2] !== request?.jobId ||
    !same(request?.sourceDirectory, job.source)
  )
    return fail();
  for (const name of ["tmp", "build", "cache", "downloads", "outputs", "evidence"]) {
    const directory = NodePath.join(root, name);
    if (
      !same(request[name + "Directory"], directory) ||
      !NodeFS.statSync(directory).isDirectory() ||
      !exact(directory)
    )
      return fail();
  }
  if (!exact(cwd) || !NodeFS.statSync(cwd).isDirectory()) return fail();
  const environment = workspaceEnvironment(request as SessionWorkspace);
  for (const name of Object.keys(environment)) {
    if (name.startsWith("T3_WORKSPACE_")) delete environment[name];
  }
  return { ...environment, WORKENV_JOB_ROOT: job.root, WORKENV_JOB_REPO: job.repo };
}
