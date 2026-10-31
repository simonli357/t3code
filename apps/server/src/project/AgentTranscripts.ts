import {
  ClaudeSettings,
  CodexSettings,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { DeepseekHarnessSettings } from "@t3tools/provider-deepseek-harness/settings";
import { resolveDeepseekHarnessHome } from "@t3tools/provider-deepseek-harness/server";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const decodeDeepseekHarnessSettings = Schema.decodeUnknownOption(DeepseekHarnessSettings);
// Claude session ids and Codex thread ids are UUIDs. Anything else is refused
// before it reaches a path, so a cursor can never name a sibling entry.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TranscriptHome {
  readonly driver: "claudeAgent" | "codex" | "deepseekHarness" | "pi";
  readonly homePath: string;
}

/**
 * The private home of a DeepSeek Harness instance, where the harness the server spawns keeps its
 * sessions. Without a configured home each instance has its own directory under the state directory.
 */
export const resolveDeepseekHarnessTranscriptHome = Effect.fn(
  "resolveDeepseekHarnessTranscriptHome",
)(function* (
  instance: ProviderInstanceConfig,
  instanceId: ProviderInstanceId,
  hostEnvironment: NodeJS.ProcessEnv,
  stateDir: string,
): Effect.fn.Return<TranscriptHome | null, never, Crypto.Crypto | Path.Path> {
  if (instance.driver !== "deepseekHarness") return null;
  const config = decodeDeepseekHarnessSettings(instance.config ?? {});
  if (Option.isNone(config)) return null;
  const home = yield* HostProcess.HomeDirectory;
  const instanceHome = instance.environment?.findLast(
    (variable) => variable.name === "DSH_HOME",
  )?.value;
  const homePath = yield* resolveDeepseekHarnessHome({
    instanceId,
    stateDir,
    settings: config.value,
    environment: { ...hostEnvironment, ...(instanceHome ? { DSH_HOME: instanceHome } : {}) },
    home,
  });
  return { driver: "deepseekHarness", homePath };
});

/**
 * An instance's native transcript home, resolved as the spawned CLI sees it: `homePath`, then
 * `CLAUDE_CONFIG_DIR`/`CODEX_HOME` from the instance or host environment, then the CLI default.
 * Null for drivers without readable transcripts or an undecodable config.
 */
export const resolveTranscriptHome = Effect.fn("resolveTranscriptHome")(function* (
  instance: ProviderInstanceConfig,
  hostEnvironment: NodeJS.ProcessEnv,
): Effect.fn.Return<TranscriptHome | null, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  if (instance.driver === "pi") {
    const agentDirectory =
      instance.environment?.findLast((variable) => variable.name === "PI_CODING_AGENT_DIR")
        ?.value ?? hostEnvironment.PI_CODING_AGENT_DIR;
    return {
      driver: "pi",
      homePath: agentDirectory?.trim()
        ? path.resolve(expandHomePath(agentDirectory.trim(), home))
        : path.join(home, ".pi", "agent"),
    };
  }
  if (instance.driver !== "claudeAgent" && instance.driver !== "codex") return null;
  const driver = instance.driver === "claudeAgent" ? "claudeAgent" : "codex";
  const homeVariable = driver === "claudeAgent" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const environmentHome =
    instance.environment?.findLast((variable) => variable.name === homeVariable)?.value ??
    hostEnvironment[homeVariable];

  if (driver === "claudeAgent") {
    const config = decodeClaudeSettings(instance.config ?? {});
    if (Option.isNone(config)) return null;
    const configured = config.value.homePath.trim() || environmentHome?.trim() || "";
    return {
      driver,
      homePath:
        configured.length > 0
          ? path.resolve(expandHomePath(configured, home))
          : path.join(home, ".claude"),
    };
  }

  const config = decodeCodexSettings(instance.config ?? {});
  if (Option.isNone(config)) return null;
  const settings =
    config.value.homePath.trim().length === 0 &&
    config.value.shadowHomePath.trim().length === 0 &&
    environmentHome?.trim()
      ? { ...config.value, homePath: environmentHome }
      : config.value;
  return { driver, homePath: (yield* resolveCodexHomeLayout(settings)).sharedHomePath };
});

export interface TranscriptEntry {
  readonly path: string;
  readonly bytes: number;
}

/**
 * The native transcript entries of one session and nothing else, never following symlinks. Pi names
 * a session by its file path, which must be a `.jsonl` file under `sessions`; other ids must be
 * UUIDs.
 */
export const findSessionTranscripts = Effect.fn("findSessionTranscripts")(function* (
  home: TranscriptHome,
  sessionId: string,
): Effect.fn.Return<ReadonlyArray<TranscriptEntry>, never, FileSystem.FileSystem | Path.Path> {
  if (home.driver !== "pi" && !SESSION_ID.test(sessionId)) return [];
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const list = (directory: string) =>
    fs.readDirectory(directory).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  // `stat` follows symlinks, so check the link itself first.
  const entryType = (target: string) =>
    fs.readLink(target).pipe(
      Effect.as("SymbolicLink" as const),
      Effect.catch(() =>
        fs.stat(target).pipe(
          Effect.map((info) => info.type),
          Effect.orElseSucceed(() => null),
        ),
      ),
    );
  const sizeOf = Effect.fn("AgentTranscripts.sizeOf")(function* (
    target: string,
  ): Effect.fn.Return<number> {
    const type = yield* entryType(target);
    if (type === "File") {
      return yield* fs.stat(target).pipe(
        Effect.map((info) => Number(info.size)),
        Effect.orElseSucceed(() => 0),
      );
    }
    if (type !== "Directory") return 0;
    let total = 0;
    for (const name of yield* list(target)) total += yield* sizeOf(path.join(target, name));
    return total;
  });
  const found: Array<TranscriptEntry> = [];

  if (home.driver === "pi") {
    const sessionsDir = path.join(home.homePath, "sessions");
    const file = path.resolve(sessionId);
    const relative = path.relative(sessionsDir, file);
    const inside =
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative);
    if (!inside || !file.endsWith(".jsonl") || (yield* entryType(file)) !== "File") return [];
    // A symlinked directory on the way would carry the delete outside the sessions directory.
    const real = yield* fs.realPath(file).pipe(Effect.orElseSucceed(() => null));
    const realSessions = yield* fs.realPath(sessionsDir).pipe(Effect.orElseSucceed(() => null));
    if (real === null || realSessions === null || real !== path.join(realSessions, relative)) {
      return [];
    }
    return [{ path: file, bytes: yield* sizeOf(file) }];
  }

  if (home.driver === "claudeAgent") {
    const projectsDir = path.join(home.homePath, "projects");
    for (const project of yield* list(projectsDir)) {
      const projectDir = path.join(projectsDir, project);
      if ((yield* entryType(projectDir)) !== "Directory") continue;
      const transcript = path.join(projectDir, `${sessionId}.jsonl`);
      if ((yield* entryType(transcript)) === "File") {
        found.push({ path: transcript, bytes: yield* sizeOf(transcript) });
      }
      const sessionDir = path.join(projectDir, sessionId);
      if ((yield* entryType(sessionDir)) === "Directory") {
        found.push({ path: sessionDir, bytes: yield* sizeOf(sessionDir) });
      }
    }
    return found;
  }

  if (home.driver === "deepseekHarness") {
    const sessionsDir = path.join(home.homePath, "sessions");
    for (const project of yield* list(sessionsDir)) {
      const projectDir = path.join(sessionsDir, project);
      if ((yield* entryType(projectDir)) !== "Directory") continue;
      const sessionDir = path.join(projectDir, sessionId);
      if ((yield* entryType(sessionDir)) === "Directory") {
        found.push({ path: sessionDir, bytes: yield* sizeOf(sessionDir) });
      }
    }
    return found;
  }

  const suffix = `-${sessionId}.jsonl`;
  const walk = Effect.fn("AgentTranscripts.walk")(function* (
    directory: string,
    depth: number,
  ): Effect.fn.Return<void> {
    for (const name of yield* list(directory)) {
      const target = path.join(directory, name);
      const type = yield* entryType(target);
      if (type === "Directory" && depth > 0) {
        yield* walk(target, depth - 1);
      } else if (type === "File" && name.startsWith("rollout-") && name.endsWith(suffix)) {
        found.push({ path: target, bytes: yield* sizeOf(target) });
      }
    }
  });
  // sessions/YYYY/MM/DD/rollout-*.jsonl; archived sessions are flat.
  yield* walk(path.join(home.homePath, "sessions"), 3);
  yield* walk(path.join(home.homePath, "archived_sessions"), 3);
  return found;
});
