#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off globalDate:off - owns disposable server processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..");
const SERVER_ENTRYPOINT = NodePath.join(REPO_ROOT, "apps/server/src/bin.ts");
const MANIFEST_FILE = "sandbox.json";
const TRANSIENT_PATHS = new Set([
  "caches",
  "runtime",
  "worktrees",
  "userdata/browser-artifacts",
  "userdata/environment-id",
  "userdata/logs",
  "userdata/server-owner.sqlite",
  "userdata/server-owner.sqlite-journal",
  "userdata/server-owner.sqlite-shm",
  "userdata/server-owner.sqlite-wal",
  "userdata/server-runtime.json",
]);
const INHERITED_SERVER_ENV_KEYS = [
  "HOST",
  "PORT",
  "T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD",
  "T3CODE_BOOTSTRAP_FD",
  "T3CODE_DEV_ALLOWED_ORIGINS",
  "T3CODE_DEV_AUTH_TOKEN",
  "T3CODE_HOME",
  "T3CODE_HOST",
  "T3CODE_LOG_WS_EVENTS",
  "T3CODE_MODE",
  "T3CODE_NO_BROWSER",
  "T3CODE_PORT",
  "T3CODE_TAILSCALE_SERVE",
  "T3CODE_TAILSCALE_SERVE_PORT",
  "T3_SERVICE_LAUNCHER_CONTEXT",
  "T3_BOOT_SERVICE_UNIT",
  "VITE_DEV_SERVER_URL",
  "VITE_HTTP_URL",
  "VITE_WS_URL",
] as const;

export class SandboxError extends Error {
  override readonly name = "SandboxError";
}

export interface SandboxConfig {
  readonly sourceHome: string | undefined;
  readonly sandboxRoot: string;
  readonly ports: ReadonlyArray<number>;
  readonly cwd: string;
  readonly readyTimeoutMs: number;
}

export interface SandboxPathSafetyInput {
  readonly sourceHome: string | undefined;
  readonly sandboxRoot: string;
  readonly homeDir: string;
  readonly inheritedHome?: string | undefined;
}

interface SandboxServer {
  readonly name: string;
  readonly home: string;
  readonly port: number;
  readonly logPath: string;
  readonly child: NodeChildProcess.ChildProcess;
}

interface SandboxManifestServer {
  readonly name: string;
  readonly pid: number;
  readonly port: number;
  readonly home: string;
  readonly origin: string;
  readonly logPath: string;
}

interface SandboxManifest {
  readonly version: 1;
  readonly sandboxId: string;
  readonly createdAt: string;
  readonly sourceHome: string | null;
  readonly cwd: string;
  readonly status: "starting" | "ready" | "stopped" | "failed";
  readonly servers: ReadonlyArray<SandboxManifestServer>;
}

type StopReason =
  | { readonly kind: "signal"; readonly signal: NodeJS.Signals }
  | { readonly kind: "child-exit"; readonly message: string };

function parseInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new SandboxError(`${flag} must be an integer.`);
  return Number(value);
}

export function parseSandboxArgs(argv: ReadonlyArray<string>): SandboxConfig {
  if (argv[0] !== "run") {
    throw new SandboxError("Usage: node scripts/v2-sandbox.ts run [options]");
  }

  let sourceHome: string | undefined;
  let sandboxRoot: string | undefined;
  let cwd: string | undefined;
  let empty = false;
  let readyTimeoutSeconds = 120;
  const ports: Array<number> = [];

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const takeValue = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new SandboxError(`${argument} requires a value.`);
      }
      index += 1;
      return value;
    };

    switch (argument) {
      case "--source-home":
        if (sourceHome !== undefined) throw new SandboxError("--source-home may appear once.");
        sourceHome = takeValue();
        break;
      case "--sandbox-root":
        if (sandboxRoot !== undefined) throw new SandboxError("--sandbox-root may appear once.");
        sandboxRoot = takeValue();
        break;
      case "--cwd":
        if (cwd !== undefined) throw new SandboxError("--cwd may appear once.");
        cwd = takeValue();
        break;
      case "--port":
        ports.push(parseInteger(takeValue(), "--port"));
        break;
      case "--ready-timeout-seconds":
        readyTimeoutSeconds = parseInteger(takeValue(), "--ready-timeout-seconds");
        break;
      case "--empty":
        if (empty) throw new SandboxError("--empty may appear once.");
        empty = true;
        break;
      default:
        throw new SandboxError(`Unknown argument: ${argument}`);
    }
  }

  if (sandboxRoot === undefined) throw new SandboxError("--sandbox-root is required.");
  if (!NodePath.isAbsolute(sandboxRoot)) {
    throw new SandboxError("--sandbox-root must be an absolute path.");
  }
  if (empty === (sourceHome !== undefined)) {
    throw new SandboxError("Pass exactly one of --source-home or --empty.");
  }
  if (sourceHome !== undefined && !NodePath.isAbsolute(sourceHome)) {
    throw new SandboxError("--source-home must be an absolute path.");
  }
  if (ports.length < 1 || ports.length > 2) {
    throw new SandboxError("Pass one or two --port values.");
  }
  for (const port of ports) {
    if (port < 1 || port > 65_535) throw new SandboxError("Ports must be between 1 and 65535.");
  }
  if (new Set(ports).size !== ports.length) throw new SandboxError("Ports must be unique.");
  if (readyTimeoutSeconds < 1 || readyTimeoutSeconds > 600) {
    throw new SandboxError("--ready-timeout-seconds must be between 1 and 600.");
  }

  const resolvedCwd = NodePath.resolve(cwd ?? REPO_ROOT);
  if (!NodePath.isAbsolute(cwd ?? REPO_ROOT)) throw new SandboxError("--cwd must be absolute.");

  return {
    sourceHome: sourceHome === undefined ? undefined : NodePath.resolve(sourceHome),
    sandboxRoot: NodePath.resolve(sandboxRoot),
    ports,
    cwd: resolvedCwd,
    readyTimeoutMs: readyTimeoutSeconds * 1_000,
  };
}

/** Resolve symlinks in the existing prefix so a job symlink cannot redirect a sandbox into live data. */
function resolveExistingPrefix(candidate: string): string {
  const absolute = NodePath.resolve(candidate);
  const suffix: Array<string> = [];
  let current = absolute;
  while (true) {
    try {
      return NodePath.join(NodeFS.realpathSync.native(current), ...suffix.reverse());
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const parent = NodePath.dirname(current);
      if (parent === current) return absolute;
      suffix.push(NodePath.basename(current));
      current = parent;
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const pathContains = (parent: string, candidate: string) => {
    const relative = NodePath.relative(parent, candidate);
    return (
      relative === "" ||
      (!relative.startsWith(`..${NodePath.sep}`) &&
        relative !== ".." &&
        !NodePath.isAbsolute(relative))
    );
  };
  return pathContains(left, right) || pathContains(right, left);
}

export function assertSafeSandboxPaths(input: SandboxPathSafetyInput): void {
  const sourceHome =
    input.sourceHome === undefined ? undefined : resolveExistingPrefix(input.sourceHome);
  const sandboxRoot = resolveExistingPrefix(input.sandboxRoot);
  const liveHomes = [NodePath.join(input.homeDir, ".t3"), input.inheritedHome]
    .filter((value): value is string => Boolean(value))
    .map(resolveExistingPrefix);

  for (const [label, candidate] of [
    ["source home", sourceHome],
    ["sandbox root", sandboxRoot],
  ] as const) {
    if (candidate === undefined) continue;
    for (const liveHome of liveHomes) {
      if (pathsOverlap(candidate, liveHome)) {
        throw new SandboxError(
          `The ${label} ${candidate} overlaps live T3 data at ${liveHome}. Choose a copied home and sandbox root under your job.`,
        );
      }
    }
  }

  if (sourceHome !== undefined && pathsOverlap(sourceHome, sandboxRoot)) {
    throw new SandboxError("The source home and sandbox root must not contain one another.");
  }
}

export function createIsolatedServerEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  for (const key of INHERITED_SERVER_ENV_KEYS) delete env[key];
  env.T3CODE_TELEMETRY_ENABLED = "false";
  return env;
}

export function createServerArgs(input: {
  readonly home: string;
  readonly port: number;
  readonly cwd: string;
}): ReadonlyArray<string> {
  return [
    SERVER_ENTRYPOINT,
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(input.port),
    "--base-dir",
    input.home,
    "--no-browser",
    "--log-level",
    "error",
    input.cwd,
  ];
}

function normalizedRelativePath(sourceRoot: string, candidate: string): string {
  return NodePath.relative(sourceRoot, candidate).split(NodePath.sep).join("/");
}

export function shouldCopyTemplatePath(sourceRoot: string, candidate: string): boolean {
  const relative = normalizedRelativePath(sourceRoot, candidate);
  if (relative === "") return true;
  for (const transient of TRANSIENT_PATHS) {
    if (relative === transient || relative.startsWith(`${transient}/`)) return false;
  }
  return true;
}

export async function copyTemplateHome(sourceHome: string, destinationHome: string): Promise<void> {
  await NodeFSP.cp(sourceHome, destinationHome, {
    recursive: true,
    errorOnExist: true,
    filter: (candidate) => shouldCopyTemplatePath(sourceHome, candidate),
  });
}

function manifestPath(sandboxRoot: string): string {
  return NodePath.join(sandboxRoot, MANIFEST_FILE);
}

async function writeManifest(sandboxRoot: string, manifest: SandboxManifest): Promise<void> {
  const path = manifestPath(sandboxRoot);
  const temporary = `${path}.${process.pid}.tmp`;
  await NodeFSP.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await NodeFSP.rename(temporary, path);
}

async function readRuntimeRecord(home: string, childPid: number, port: number): Promise<boolean> {
  const path = NodePath.join(home, "userdata", "server-runtime.json");
  try {
    const value: unknown = JSON.parse(await NodeFSP.readFile(path, "utf8"));
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    return record.pid === childPid && record.port === port;
  } catch {
    return false;
  }
}

function httpProtocolVersion(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const request = NodeHttp.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/.well-known/t3/environment",
        method: "GET",
        timeout: 1_000,
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes <= 64 * 1_024) chunks.push(chunk);
        });
        response.once("end", () => {
          if (response.statusCode !== 200) {
            resolve(null);
            return;
          }
          try {
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const protocol =
              typeof value === "object" && value !== null
                ? (value as Record<string, unknown>).orchestrationProtocolVersion
                : undefined;
            resolve(typeof protocol === "number" ? protocol : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(null));
    request.end();
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readLogTail(path: string): Promise<string> {
  try {
    const value = await NodeFSP.readFile(path, "utf8");
    return value.slice(-4_000).trim();
  } catch {
    return "";
  }
}

async function waitUntilReady(server: SandboxServer, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null || server.child.signalCode !== null) {
      const tail = await readLogTail(server.logPath);
      throw new SandboxError(
        `${server.name} exited before readiness.${tail.length > 0 ? `\n${tail}` : ""}`,
      );
    }
    const runtimeReady = await readRuntimeRecord(server.home, server.child.pid!, server.port);
    if (runtimeReady) {
      const protocol = await httpProtocolVersion(server.port);
      if (protocol === 2) return;
    }
    await delay(100);
  }

  const tail = await readLogTail(server.logPath);
  throw new SandboxError(
    `${server.name} did not become HTTP-ready within ${timeoutMs / 1_000}s.${tail.length > 0 ? `\n${tail}` : ""}`,
  );
}

function isChildRunning(child: NodeChildProcess.ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null && child.pid !== undefined;
}

async function stopServer(server: SandboxServer): Promise<void> {
  if (!isChildRunning(server.child)) return;
  const exited = new Promise<void>((resolve) => server.child.once("exit", () => resolve()));
  server.child.kill("SIGTERM");
  const graceful = await Promise.race([exited.then(() => true), delay(10_000).then(() => false)]);
  if (!graceful && isChildRunning(server.child)) {
    server.child.kill("SIGKILL");
    await exited;
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (NodeOS.constants.signals[signal] ?? 1);
}

export async function runSandbox(config: SandboxConfig): Promise<number> {
  assertSafeSandboxPaths({
    sourceHome: config.sourceHome,
    sandboxRoot: config.sandboxRoot,
    homeDir: NodeOS.homedir(),
    inheritedHome: process.env.T3CODE_HOME,
  });
  if (config.sourceHome !== undefined) {
    const source = await NodeFSP.stat(config.sourceHome).catch(() => undefined);
    if (!source?.isDirectory())
      throw new SandboxError("--source-home must be an existing directory.");
  }
  const cwd = await NodeFSP.stat(config.cwd).catch(() => undefined);
  if (!cwd?.isDirectory()) throw new SandboxError("--cwd must be an existing directory.");
  if (NodeFS.existsSync(config.sandboxRoot)) {
    throw new SandboxError(
      "--sandbox-root must not exist; a fresh root prevents accidental reuse.",
    );
  }

  await NodeFSP.mkdir(config.sandboxRoot, { recursive: false, mode: 0o700 });
  const sandboxId = NodeCrypto.randomUUID();
  const createdAt = new Date().toISOString();
  const prepared = config.ports.map((port, index) => ({
    name: `server-${index + 1}`,
    home: NodePath.join(config.sandboxRoot, `home-${index + 1}`),
    port,
    logPath: NodePath.join(config.sandboxRoot, `server-${index + 1}.log`),
  }));

  await Promise.all(
    prepared.map((server) =>
      config.sourceHome === undefined
        ? NodeFSP.mkdir(server.home, { recursive: false, mode: 0o700 })
        : copyTemplateHome(config.sourceHome, server.home),
    ),
  );

  const servers: Array<SandboxServer> = [];
  let status: SandboxManifest["status"] = "starting";
  let stopReason: StopReason | undefined;
  let resolveStop!: (reason: StopReason) => void;
  const stopEvent = new Promise<StopReason>((resolve) => {
    resolveStop = resolve;
  });
  const requestStop = (reason: StopReason) => {
    if (stopReason !== undefined) return;
    stopReason = reason;
    resolveStop(reason);
  };
  const onSignal = (signal: NodeJS.Signals) => requestStop({ kind: "signal", signal });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, onSignal);

  let exitCode = 0;
  try {
    for (const server of prepared) {
      const logDescriptor = NodeFS.openSync(server.logPath, "a", 0o600);
      let child: NodeChildProcess.ChildProcess;
      try {
        child = NodeChildProcess.spawn(
          process.execPath,
          createServerArgs({ home: server.home, port: server.port, cwd: config.cwd }),
          {
            cwd: REPO_ROOT,
            env: createIsolatedServerEnv(process.env),
            stdio: ["ignore", logDescriptor, logDescriptor],
          },
        );
      } finally {
        NodeFS.closeSync(logDescriptor);
      }
      if (child.pid === undefined) throw new SandboxError(`${server.name} did not start.`);
      const running = { ...server, child };
      servers.push(running);
      child.once("exit", (code, signal) => {
        if (stopReason === undefined) {
          requestStop({
            kind: "child-exit",
            message: `${server.name} exited unexpectedly (${signal ?? `code ${code ?? "unknown"}`}).`,
          });
        }
      });
      child.once("error", (error) => {
        if (stopReason === undefined) {
          requestStop({ kind: "child-exit", message: `${server.name} failed: ${error.message}` });
        }
      });
    }

    const baseManifest = {
      version: 1 as const,
      sandboxId,
      createdAt,
      sourceHome: config.sourceHome ?? null,
      cwd: config.cwd,
      servers: servers.map((server) => ({
        name: server.name,
        pid: server.child.pid!,
        port: server.port,
        home: server.home,
        origin: `http://127.0.0.1:${server.port}`,
        logPath: server.logPath,
      })),
    };
    await writeManifest(config.sandboxRoot, { ...baseManifest, status });

    const ready = Promise.all(
      servers.map((server) => waitUntilReady(server, config.readyTimeoutMs)),
    ).then(() => "ready" as const);
    const first = await Promise.race([ready, stopEvent]);
    if (first !== "ready") {
      if (first.kind === "signal") {
        exitCode = signalExitCode(first.signal);
      } else {
        throw new SandboxError(first.message);
      }
    } else {
      status = "ready";
      await writeManifest(config.sandboxRoot, { ...baseManifest, status });
      console.log(
        [
          `Sandbox ${sandboxId} is ready (${servers.length} isolated server${servers.length === 1 ? "" : "s"}).`,
          ...servers.map(
            (server) =>
              `  ${server.name}: ${`http://127.0.0.1:${server.port}`} pid=${server.child.pid} home=${server.home}`,
          ),
          `  manifest: ${manifestPath(config.sandboxRoot)}`,
          "Press Ctrl-C to stop exactly these child processes.",
        ].join("\n"),
      );

      const finalReason = await stopEvent;
      if (finalReason.kind === "child-exit") throw new SandboxError(finalReason.message);
      exitCode = signalExitCode(finalReason.signal);
    }
  } catch (error) {
    status = "failed";
    throw error;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, onSignal);
    await Promise.allSettled(servers.map(stopServer));
    const survivors = servers.filter(
      (server) => server.child.pid !== undefined && pidIsAlive(server.child.pid),
    );
    if (survivors.length > 0) {
      status = "failed";
      console.error(
        `Sandbox stop failed for PIDs: ${survivors.map((server) => server.child.pid).join(", ")}`,
      );
      exitCode = 1;
    } else if (status !== "failed") {
      status = "stopped";
    }
    if (servers.length > 0) {
      const stoppedManifest: SandboxManifest = {
        version: 1,
        sandboxId,
        createdAt,
        sourceHome: config.sourceHome ?? null,
        cwd: config.cwd,
        status,
        servers: servers.map((server) => ({
          name: server.name,
          pid: server.child.pid!,
          port: server.port,
          home: server.home,
          origin: `http://127.0.0.1:${server.port}`,
          logPath: server.logPath,
        })),
      };
      await writeManifest(config.sandboxRoot, stoppedManifest).catch(() => undefined);
    }
  }

  return exitCode;
}

async function main(): Promise<void> {
  const config = parseSandboxArgs(process.argv.slice(2));
  process.exitCode = await runSandbox(config);
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    const message = NodeUtil.inspect(error instanceof Error ? error.message : error);
    console.error(`v2-sandbox: ${message}`);
    process.exitCode = 1;
  });
}
