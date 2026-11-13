import * as NodeOS from "node:os";

import type { ClaudeSettings, ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../../pathExpansion.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/**
 * Resolve the Claude config directory the CLI would use: the instance's
 * `homePath` (exported as `CLAUDE_CONFIG_DIR`), then an inherited
 * `CLAUDE_CONFIG_DIR`, then Claude's default `~/.claude`. Empty must not
 * fall back to bare `$HOME` — that leftover from the old HOME override
 * produced a different continuation group than an explicit `~/.claude`.
 */
export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath));
  }
  // Inherited env vars are not shell-expanded, so a literal `~` stays literal.
  const inherited = environment?.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inherited.length > 0) {
    return path.resolve(inherited);
  }
  return path.resolve(path.join(NodeOS.homedir(), ".claude"));
});

/** The one field of the login record T3 reads; credentials beside it are never decoded. */
const decodeLoginTier = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      claudeAiOauth: Schema.optional(
        Schema.Struct({ rateLimitTier: Schema.optional(Schema.String) }),
      ),
    }),
  ),
);

/** The last tier read per login, for a read that catches the record mid-rewrite. */
const lastTiers = new Map<string, string | undefined>();

/**
 * The plan's usage tier from the login record (`.credentials.json`): Pro, Max 5x or Max 20x.
 * The SDK reports only "Claude Max", which cannot size an account. Absent where the login lives
 * in the macOS keychain or the tier is one this does not know. A record that cannot be read
 * keeps the last tier: a plan that flickered would restart what allocation learned about it.
 */
export const readClaudePlanTier = Effect.fn("readClaudePlanTier")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* resolveClaudeHomePath(config, environment);
  const record = yield* fileSystem.readFileString(path.join(home, ".credentials.json")).pipe(
    Effect.option,
    Effect.map((text) => Option.flatMap(text, decodeLoginTier)),
  );
  if (Option.isNone(record)) return lastTiers.get(home);
  const raw = record.value.claudeAiOauth?.rateLimitTier;
  const max = raw ? /max_(\d+)x/.exec(raw) : null;
  const tier = raw === "default_claude_ai" ? "Pro" : max ? `Max ${max[1]}x` : undefined;
  lastTiers.set(home, tier);
  return tier;
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...resolvedBaseEnv,
    // Isolate this instance's config via CLAUDE_CONFIG_DIR rather than HOME.
    // Overriding HOME also relocates the macOS login keychain lookup
    // ($HOME/Library/Keychains), so the spawned CLI can't find its stored
    // OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
    // Claude Code at its config dir directly while leaving HOME (and the
    // keychain) intact.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

/**
 * Base env for the Claude processes T3 Code runs, before `makeClaudeEnvironment`.
 * Claude Code reports its entrypoint to Anthropic, which meters the Agent SDK
 * default (`sdk-ts`) faster against the 5-hour limit than an interactive
 * session. The instance's own environment wins. In-app terminals do not use
 * this, so an interactive `claude` there keeps its own entrypoint.
 */
export function mergeClaudeProcessEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  hostEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return mergeProviderInstanceEnvironment(environment, {
    ...hostEnvironment,
    CLAUDE_CODE_ENTRYPOINT: "t3-code",
  });
}

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);

/**
 * Describe the spawned CLI's environment separately from the login command so
 * paths remain literal on every shell, including relative inherited values.
 */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `Claude could not authenticate. For subscription login, run \`claude auth login\` on this environment's machine${configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials.`;
};
