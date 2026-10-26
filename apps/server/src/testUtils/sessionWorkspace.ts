// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import type { SessionWorkspace } from "../workspace/SessionWorkspaces.ts";
import * as Schema from "effect/Schema";

export const encodeProbePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));
export const decodeWorkspaceProbe = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      pid: Schema.Number,
      cwd: Schema.String,
      tmp: Schema.String,
      job: Schema.String,
      home: Schema.optional(Schema.String),
    }),
  ),
);

export const sessionWorkspaceFixture = (workspaceDirectory: string): SessionWorkspace => {
  const root = NodePath.dirname(workspaceDirectory);
  return {
    version: 1,
    jobId: "job-id",
    threadId: "workspace-thread",
    reservationId: "new:workspace-thread",
    root,
    workspaceDirectory,
    sourceDirectory: NodePath.join(root, "persistent-source"),
    tmpDirectory: NodePath.join(root, "tmp"),
    buildDirectory: NodePath.join(root, "build"),
    cacheDirectory: NodePath.join(root, "cache"),
    downloadsDirectory: NodePath.join(root, "downloads"),
    outputsDirectory: NodePath.join(root, "outputs"),
    evidenceDirectory: NodePath.join(root, "evidence"),
    revision: "fixture-revision",
    branch: null,
    lifecycleCommand: null,
  };
};
