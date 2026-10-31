import { ClaudeSettings, CodexSettings, type ProviderInstanceConfig } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
// Claude session ids and Codex thread ids are UUIDs. Anything else is refused
// before it reaches a path, so a cursor can never name a sibling entry.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TranscriptHome {
  readonly driver: "claudeAgent" | "codex" | "deepseekHarness";
  readonly homePath: string;
}

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
 * The native transcript entries of one session and nothing else: Claude's `<sessionId>.jsonl` plus
 * its sibling directory, or Codex's `rollout-*-<threadId>.jsonl` files. Symlinks are never
 * followed, and a session id that is not a UUID yields nothing.
 */
export const findSessionTranscripts = Effect.fn("findSessionTranscripts")(function* (
  home: TranscriptHome,
  sessionId: string,
): Effect.fn.Return<ReadonlyArray<TranscriptEntry>, never, FileSystem.FileSystem | Path.Path> {
  if (!SESSION_ID.test(sessionId)) return [];
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
