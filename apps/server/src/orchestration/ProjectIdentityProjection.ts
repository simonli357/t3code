import type {
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
  RepositoryIdentity,
} from "@t3tools/contracts";

function projectIdentity<
  T extends { readonly repositoryIdentity?: RepositoryIdentity | null | undefined },
>(project: T): T {
  return project.repositoryIdentity?.locator.source === "project-config"
    ? { ...project, repositoryIdentity: null }
    : project;
}

/** Older clients only decode Git locators. Keep their projects visible without inventing origins. */
export function projectSnapshotIdentities<
  T extends OrchestrationShellSnapshot | OrchestrationReadModel,
>(snapshot: T, supportsProjectConfig: boolean): T {
  return supportsProjectConfig
    ? snapshot
    : { ...snapshot, projects: snapshot.projects.map(projectIdentity) };
}

export function projectShellIdentities(
  item: OrchestrationShellStreamItem,
  supportsProjectConfig: boolean,
): OrchestrationShellStreamItem {
  if (supportsProjectConfig) return item;
  if (item.kind === "snapshot") {
    return { ...item, snapshot: projectSnapshotIdentities(item.snapshot, false) };
  }
  return item.kind === "project-upserted"
    ? { ...item, project: projectIdentity(item.project) }
    : item;
}
