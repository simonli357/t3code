import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { workspaceEnvironment, type SessionWorkspace } from "./SessionWorkspaces.ts";

const job = (root: string): SessionWorkspace => ({
  version: 1,
  jobId: "job",
  threadId: "thread",
  reservationId: "reservation",
  root,
  sourceDirectory: "/primary",
  workspaceDirectory: NodePath.join(root, "repo"),
  tmpDirectory: NodePath.join(root, "tmp"),
  buildDirectory: NodePath.join(root, "build"),
  cacheDirectory: NodePath.join(root, "cache"),
  downloadsDirectory: NodePath.join(root, "downloads"),
  outputsDirectory: NodePath.join(root, "outputs"),
  evidenceDirectory: NodePath.join(root, "evidence"),
  revision: "HEAD",
  branch: null,
  lifecycleCommand: null,
});

describe("workspaceEnvironment", () => {
  it("merges only allowed workenv redirects inside the job root", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-job-env-"));
    try {
      expect(workspaceEnvironment(job(root)).GOMODCACHE).toBeUndefined();
      NodeFS.writeFileSync(
        NodePath.join(root, ".workenv-environment.json"),
        JSON.stringify({
          version: 1,
          environment: {
            GOMODCACHE: NodePath.join(root, "cache", "go", "mod"),
            MAVEN_OPTS: "-Dmaven.repo.local=" + NodePath.join(root, "cache", "m2"),
            UV_CACHE_DIR: NodePath.join(NodeOS.tmpdir(), "outside"),
            PATH: NodePath.join(root, "bin"),
            TMPDIR: NodePath.join(root, "other"),
          },
        }),
      );
      const environment = workspaceEnvironment(job(root));
      expect(environment.GOMODCACHE).toBe(NodePath.join(root, "cache", "go", "mod"));
      expect(environment.MAVEN_OPTS).toBe(
        "-Dmaven.repo.local=" + NodePath.join(root, "cache", "m2"),
      );
      expect(environment.UV_CACHE_DIR).toBeUndefined();
      expect(environment.PATH).toBeUndefined();
      expect(environment.TMPDIR).toBe(NodePath.join(root, "tmp"));
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
