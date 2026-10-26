import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  ProjectId,
  RepositoryIdentity,
} from "@t3tools/contracts";
import { projectShellIdentities, projectSnapshotIdentities } from "./ProjectIdentityProjection.ts";

// The locator schema shipped before project-config identities existed.
const legacyIdentity = Schema.Struct({
  ...RepositoryIdentity.fields,
  locator: Schema.Struct({
    source: Schema.Literal("git-remote"),
    remoteName: Schema.String,
    remoteUrl: Schema.String,
  }),
});
const legacyProject = Schema.Struct({
  ...OrchestrationProjectShell.fields,
  repositoryIdentity: Schema.optional(Schema.NullOr(legacyIdentity)),
});
const legacySnapshot = Schema.Struct({
  ...OrchestrationShellSnapshot.fields,
  projects: Schema.Array(legacyProject),
});
const project: OrchestrationProjectShell = {
  id: ProjectId.make("context"),
  title: "Home",
  workspaceRoot: "/home/example",
  repositoryIdentity: {
    canonicalKey: "project:example/home",
    locator: { source: "project-config", projectKey: "example/home" },
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-23T12:00:00Z",
  updatedAt: "2026-10-23T12:00:00Z",
};
const gitProject: OrchestrationProjectShell = {
  ...project,
  id: ProjectId.make("git"),
  repositoryIdentity: {
    canonicalKey: "github.com/example/repo",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/example/repo.git",
    },
  },
};
const snapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 7,
  projects: [project, gitProject],
  threads: [],
  updatedAt: project.updatedAt,
};

describe("project identity wire compatibility", () => {
  it("keeps legacy HTTP, initial and archived snapshots decodable without fake origins", () => {
    expect(() => Schema.decodeUnknownSync(legacySnapshot)(snapshot)).toThrow();
    const result = projectSnapshotIdentities(snapshot, false);
    expect(() => Schema.decodeUnknownSync(legacySnapshot)(result)).not.toThrow();
    expect(result.projects[0]).toEqual({ ...project, repositoryIdentity: null });
    expect(result.projects[1]).toBe(gitProject);
    expect(result.threads).toBe(snapshot.threads);
    expect(project.repositoryIdentity?.canonicalKey).toBe("project:example/home");
  });
  it("projects both replay/live project upserts and socket snapshot fallback", () => {
    const event = { kind: "project-upserted" as const, sequence: 8, project };
    const result = projectShellIdentities(event, false);
    expect(result.kind).toBe("project-upserted");
    if (result.kind !== "project-upserted") throw new Error("wrong event");
    expect(() => Schema.decodeUnknownSync(legacyProject)(result.project)).not.toThrow();
    const initial = projectShellIdentities({ kind: "snapshot", snapshot }, false);
    if (initial.kind !== "snapshot") throw new Error("wrong snapshot");
    expect(() => Schema.decodeUnknownSync(legacySnapshot)(initial.snapshot)).not.toThrow();
  });
  it("preserves full identities for opted-in clients and unrelated events by reference", () => {
    const event = { kind: "project-upserted" as const, sequence: 8, project };
    expect(projectSnapshotIdentities(snapshot, true)).toBe(snapshot);
    expect(projectShellIdentities(event, true)).toBe(event);
    const removed = { kind: "project-removed" as const, sequence: 9, projectId: project.id };
    expect(projectShellIdentities(removed, false)).toBe(removed);
  });
});
