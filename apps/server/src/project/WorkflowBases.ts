// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { BaseSessionConfiguration, ProjectId, AgentSessionForkError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

const Account = Schema.Struct({ instanceId: Schema.String, base: Schema.String });
const Profile = Schema.Struct({
  baseProject: Schema.String,
  basePrompt: Schema.optional(Schema.String),
  bases: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const Configuration = Schema.Struct({
  accounts: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Account))),
  projects: Schema.optional(Schema.Record(Schema.String, Profile)),
  skillHomes: Schema.optional(Schema.Array(Schema.String)),
  enabledAccounts: Schema.optional(Schema.Array(Schema.String)),
});
const Defaults = Schema.Struct({ accounts: Schema.Record(Schema.String, Account) });

const decodeConfiguration = Schema.decodeEffect(Schema.fromJsonString(Configuration));
const decodeDefaults = Schema.decodeEffect(Schema.fromJsonString(Defaults));
const isForkError = Schema.is(AgentSessionForkError);

/** Suggestions are account + project scoped. Explicit selection persists the
 * thread ID through thread.meta.update; names never determine runtime behavior. */
export const readWorkflowBases = Effect.fn(
  function* (projectId: ProjectId) {
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* HostProcessPlatform;
    const path = yield* Path.Path;
    const snapshots = yield* ProjectionSnapshotQuery;
    const project = yield* snapshots.getProjectShellById(projectId);
    if (Option.isNone(project))
      return yield* new AgentSessionForkError({ message: "Project unavailable." });
    const configPath =
      process.env.T3_WORKFLOWS_CONFIG ??
      path.join(NodeOS.homedir(), ".config", "t3-workflows", "config.json");
    if (!(yield* fs.exists(configPath)))
      return {
        configuredPrompt: null,
        candidates: [],
        warning: null,
      } satisfies BaseSessionConfiguration;
    const config = yield* decodeConfiguration(
      (yield* fs.readFileString(configPath)).replace(/^\uFEFF/, ""),
    );
    let accounts: Record<string, typeof Account.Type | null> = {};
    for (const home of config.skillHomes ?? [path.join(NodeOS.homedir(), ".codex")]) {
      const file = path.join(home, "skills", "t3-fork-session", "references", "accounts.json");
      if (yield* fs.exists(file)) {
        accounts = (yield* decodeDefaults(yield* fs.readFileString(file))).accounts;
        break;
      }
    }
    accounts = { ...accounts, ...config.accounts };
    const canonical = Effect.fn(function* (value: string) {
      const expanded = value.startsWith("~/")
        ? path.join(NodeOS.homedir(), value.slice(2))
        : path.resolve(value);
      const real = yield* fs.realPath(expanded).pipe(Effect.orElseSucceed(() => expanded));
      return platform === "win32" ? real.toLowerCase() : real;
    });
    const root = yield* canonical(project.value.workspaceRoot);
    const matches = yield* Effect.filter(Object.values(config.projects ?? {}), (profile) =>
      canonical(profile.baseProject).pipe(Effect.map((p) => p === root)),
    );
    if (matches.length > 1)
      return {
        configuredPrompt: null,
        candidates: [],
        warning:
          "Multiple workflow profiles match this project. Resolve the profile ambiguity before adopting its bases.",
      } satisfies BaseSessionConfiguration;
    const profile = matches[0];
    const shell = yield* snapshots.getShellSnapshot();
    const candidates: BaseSessionConfiguration["candidates"][number][] = [];
    const ambiguous: string[] = [];
    for (const [name, account] of Object.entries(accounts)) {
      if (!account || (config.enabledAccounts && !config.enabledAccounts.includes(name))) continue;
      const title = profile?.bases?.[name] ?? account.base;
      const threads = shell.threads.filter(
        (t) =>
          t.projectId === projectId &&
          t.archivedAt === null &&
          t.title.toLowerCase() === title.toLowerCase() &&
          t.modelSelection.instanceId === account.instanceId,
      );
      if (threads.length > 1) {
        ambiguous.push(title);
        continue;
      }
      for (const thread of threads)
        candidates.push({
          threadId: thread.id,
          title: thread.title,
          instanceId: thread.modelSelection.instanceId,
        });
    }
    return {
      configuredPrompt: profile?.basePrompt ?? null,
      candidates,
      warning: ambiguous.length
        ? `Ambiguous configured bases: ${ambiguous.join(", ")}. Open the intended session and designate it explicitly.`
        : null,
    } satisfies BaseSessionConfiguration;
  },
  Effect.mapError((cause) =>
    isForkError(cause)
      ? cause
      : new AgentSessionForkError({
          message:
            "Could not read workflow base configuration. Existing bases and prompts were left unchanged.",
        }),
  ),
);
