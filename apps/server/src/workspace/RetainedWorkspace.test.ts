// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { retainedWorkspaceEnvironment } from "./RetainedWorkspace.ts";

describe("retained workspace launch", () => {
  it("uses reconciled paths without enabling T3 lifecycle hooks and rejects stale identity", () => {
    const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "retained-workspace-"));
    const threadId = "d819e837-a0c4-4004-bfab-bff7316c8c31";
    const root = NodePath.join(base, "sessions", threadId);
    const cwd = NodePath.join(root, "repo");
    const from = NodePath.join(base, "jobs", threadId);
    const directories = ["tmp", "build", "cache", "downloads", "outputs", "evidence"];
    try {
      for (const name of ["repo", ...directories])
        NodeFS.mkdirSync(NodePath.join(root, name), { recursive: true });
      const job = {
        identity: ["t3", NodeOS.homedir(), threadId],
        status: "released",
        root,
        repo: cwd,
        source: base,
        relocated_to: root,
        t3_relocation: { from, to: root },
        t3_registration: {
          jobId: threadId,
          threadId,
          root,
          workspaceDirectory: cwd,
          sourceDirectory: base,
          outputsDirectory: NodePath.join(root, "outputs"),
          ...Object.fromEntries(
            directories.map((name) => [name + "Directory", NodePath.join(root, name)]),
          ),
        },
      };
      const metadata = NodePath.join(root, ".workenv.json");
      const write = () => NodeFS.writeFileSync(metadata, JSON.stringify(job));
      write();
      const env = retainedWorkspaceEnvironment(threadId, cwd)!;
      expect(env.WORKENV_JOB_ROOT).toBe(root);
      expect(env.WORKENV_JOB_REPO).toBe(cwd);
      expect(env.TMPDIR).toBe(NodePath.join(root, "tmp"));
      expect(env.T3_WORKSPACE_JOB_ID).toBeUndefined();
      expect(env.T3_WORKSPACE_JOB_ROOT).toBeUndefined();
      if (NodePath.sep === "\\") {
        for (const input of [cwd.replaceAll("\\", "/"), cwd.toLowerCase(), cwd.toUpperCase()]) {
          expect(retainedWorkspaceEnvironment(threadId, input)).toEqual(env);
        }
      }
      expect(() => retainedWorkspaceEnvironment("unrelated", cwd)).toThrow("Reconcile");
      job.root = from;
      write();
      expect(() => retainedWorkspaceEnvironment(threadId, cwd)).toThrow("Reconcile");
      job.root = root;
      job.t3_registration.outputsDirectory = base;
      write();
      expect(() => retainedWorkspaceEnvironment(threadId, cwd)).toThrow("Reconcile");
      job.t3_registration.outputsDirectory = NodePath.join(root, "outputs");
      write();
      NodeFS.mkdirSync(NodePath.join(from, "tmp"), { recursive: true });
      expect(retainedWorkspaceEnvironment(threadId, cwd)?.WORKENV_JOB_ROOT).toBe(root);
      NodeFS.mkdirSync(NodePath.join(from, "repo"), { recursive: true });
      expect(() => retainedWorkspaceEnvironment(threadId, cwd)).toThrow("Reconcile");
    } finally {
      NodeFS.rmSync(base, { recursive: true, force: true });
    }
  });
});
