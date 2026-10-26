import type { RepositoryIdentity, SourceControlProviderError } from "@t3tools/contracts";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
} from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProcessRunner from "../processRunner.ts";
import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

const DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY = 512;
// Background sweeps resolve every project each minute. A long TTL keeps them
// from spawning git each time. Clone, publish, and PR discovery (after a turn
// and before it saves links) resolve with `refresh: true`.
const DEFAULT_POSITIVE_CACHE_TTL = Duration.minutes(15);
// Short, so a folder that gains a repository or a remote shows up quickly.
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.minutes(1);

export interface RepositoryIdentityResolverOptions {
  readonly cacheCapacity?: number;
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
  readonly refine?: (
    identity: RepositoryIdentity,
  ) => Effect.Effect<RepositoryIdentity, SourceControlProviderError>;
}

export class RepositoryIdentityResolver extends Context.Service<
  RepositoryIdentityResolver,
  {
    readonly resolve: (
      cwd: string,
      options?: { readonly refresh?: boolean },
    ) => Effect.Effect<RepositoryIdentity | null>;
  }
>()("t3/project/RepositoryIdentityResolver") {}

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Partial clones append their object filter (or [promisor]) to fetch rows.
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)(?:\s+\[[^\]\r\n]*\])?$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

function pickPrimaryRemote(
  remotes: ReadonlyMap<string, string>,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  for (const preferredRemoteName of ["upstream", "origin"] as const) {
    const remoteUrl = remotes.get(preferredRemoteName);
    if (remoteUrl) {
      return { remoteName: preferredRemoteName, remoteUrl };
    }
  }

  const [remoteName, remoteUrl] =
    [...remotes.entries()].toSorted(([left], [right]) => left.localeCompare(right))[0] ?? [];
  return remoteName && remoteUrl ? { remoteName, remoteUrl } : null;
}

function buildRepositoryIdentity(input: {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly identityUrl?: string;
  readonly rootPath: string;
}): RepositoryIdentity {
  const identityUrl = input.identityUrl ?? input.remoteUrl;
  const canonicalKey = normalizeGitRemoteUrl(identityUrl);
  const sourceControlProvider = detectSourceControlProviderFromGitRemoteUrl(identityUrl);
  const repositoryPath = canonicalKey.split("/").slice(1).join("/");
  const repositoryPathSegments = repositoryPath.split("/").filter((segment) => segment.length > 0);
  const [owner] = repositoryPathSegments;
  const repositoryName = repositoryPathSegments.at(-1);

  return {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: input.remoteName,
      remoteUrl: input.remoteUrl,
    },
    rootPath: input.rootPath,
    ...(repositoryPath ? { displayName: repositoryPath } : {}),
    ...(sourceControlProvider ? { provider: sourceControlProvider.kind } : {}),
    ...(owner ? { owner } : {}),
    ...(repositoryName ? { name: repositoryName } : {}),
  };
}

const resolveSshIdentityUrl = Effect.fn("RepositoryIdentityResolver.resolveSshIdentityUrl")(
  function* (remoteUrl: string) {
    const provider = detectSourceControlProviderFromGitRemoteUrl(remoteUrl);
    if (provider && provider.kind !== "unknown") return remoteUrl;
    const scp = /^([^@\s]+@)([a-zA-Z0-9][a-zA-Z0-9._-]*):(.+)$/.exec(remoteUrl);
    let url: URL | undefined;
    if (remoteUrl.startsWith("ssh://")) {
      try {
        url = new URL(remoteUrl);
      } catch {
        return remoteUrl;
      }
    }
    const host = scp?.[2] ?? url?.hostname;
    if (!host || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host)) return remoteUrl;
    const user = scp?.[1]?.slice(0, -1) ?? url?.username;
    const runner = yield* ProcessRunner.ProcessRunner;
    // -G reads local SSH configuration without connecting. Keep the original
    // locator so Git still selects the alias's configured account and key.
    const result = yield* runner
      .run({
        command: "ssh",
        args: [
          "-G",
          "-o",
          "CanonicalizeHostname=no",
          ...(user ? ["-l", user] : []),
          ...(url?.port ? ["-p", url.port] : []),
          host,
        ],
        timeout: Duration.seconds(5),
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (Option.isNone(result) || result.value.code !== 0) return remoteUrl;
    const hostname = /^hostname\s+(\S+)\s*$/m.exec(result.value.stdout)?.[1];
    if (!hostname || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(hostname)) return remoteUrl;
    if (url) {
      url.hostname = hostname;
      return url.href;
    }
    return `${scp?.[1]}${hostname}:${scp?.[3]}`;
  },
);

const resolveRepositoryIdentityCacheKey = Effect.fn("RepositoryIdentityResolver.resolveCacheKey")(
  function* (cwd: string) {
    const processRunner = yield* ProcessRunner.ProcessRunner;

    // git is a real executable on every platform — no cmd.exe shell mode, which
    // would split paths containing spaces during cmd's re-tokenization.
    const topLevelResult = yield* processRunner
      .run({
        command: "git",
        args: ["-C", cwd, "rev-parse", "--show-toplevel"],
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (topLevelResult._tag === "None" || topLevelResult.value.code !== 0) {
      return null;
    }

    const candidate = topLevelResult.value.stdout.trim();
    return candidate.length > 0 ? candidate : null;
  },
);

const resolveRepositoryIdentityFromCacheKey = Effect.fn(
  "RepositoryIdentityResolver.resolveFromCacheKey",
)(function* (
  cacheKey: string,
): Effect.fn.Return<RepositoryIdentity | null, never, ProcessRunner.ProcessRunner> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const remoteResult = yield* processRunner
    .run({
      command: "git",
      args: ["-C", cacheKey, "remote", "-v"],
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.option);
  if (remoteResult._tag === "None" || remoteResult.value.code !== 0) {
    return null;
  }

  const remote = pickPrimaryRemote(parseRemoteFetchUrls(remoteResult.value.stdout));
  if (!remote) return null;
  const identityUrl = yield* resolveSshIdentityUrl(remote.remoteUrl);
  return buildRepositoryIdentity({ ...remote, identityUrl, rootPath: cacheKey });
});

export const make = Effect.fn("RepositoryIdentityResolver.make")(function* (
  options: RepositoryIdentityResolverOptions = {},
) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const projectFiles = yield* T3ProjectFileLoader.T3ProjectFileLoader;
  const cacheCapacity = options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY;
  const refine = options.refine ?? Effect.succeed;
  // Git errors and timeouts resolve to null, so they use the negative TTL like
  // "no repository" or "no remote". Only interrupts and defects skip the cache.
  const timeToLive = (exit: Exit.Exit<unknown>) =>
    Exit.match(exit, {
      onSuccess: (value) =>
        value === null
          ? (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL)
          : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
      onFailure: () => Duration.zero,
    });

  const projectIdentityCache = yield* Cache.makeWith<string, RepositoryIdentity | null>(
    (cwd) =>
      projectFiles.load(cwd).pipe(
        Effect.map((config) => {
          const projectKey = Option.getOrNull(config)?.projectKey;
          return projectKey
            ? {
                canonicalKey: `project:${projectKey}`,
                locator: { source: "project-config" as const, projectKey },
                rootPath: cwd,
              }
            : null;
        }),
      ),
    { capacity: cacheCapacity, timeToLive },
  );

  const repositoryRootCache = yield* Cache.makeWith<string, string | null>(
    (cwd) =>
      resolveRepositoryIdentityCacheKey(cwd).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      ),
    { capacity: cacheCapacity, timeToLive },
  );

  const repositoryIdentityCache = yield* Cache.makeWith<string, RepositoryIdentity | null>(
    (cacheKey) =>
      resolveRepositoryIdentityFromCacheKey(cacheKey).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.filterOrElse(
          (identity): identity is null => identity === null,
          (identity) => refine(identity).pipe(Effect.orElseSucceed(() => identity)),
        ),
      ),
    { capacity: cacheCapacity, timeToLive },
  );

  // Untraced because almost every call is a cache hit. The lookups that spawn
  // git keep their own spans.
  const resolve: RepositoryIdentityResolver["Service"]["resolve"] = Effect.fnUntraced(
    function* (cwd, options) {
      if (options?.refresh) yield* Cache.invalidate(projectIdentityCache, cwd);
      const projectIdentity = yield* Cache.get(projectIdentityCache, cwd);
      if (projectIdentity !== null) return projectIdentity;
      if (options?.refresh) yield* Cache.invalidate(repositoryRootCache, cwd);
      const cacheKey = yield* Cache.get(repositoryRootCache, cwd);
      if (cacheKey === null) return null;
      if (options?.refresh) yield* Cache.invalidate(repositoryIdentityCache, cacheKey);
      return yield* Cache.get(repositoryIdentityCache, cacheKey);
    },
  );

  return RepositoryIdentityResolver.of({ resolve });
});

export const layer = Layer.effect(RepositoryIdentityResolver, make()).pipe(
  Layer.provide([ProcessRunner.layer, T3ProjectFileLoader.layer]),
);
