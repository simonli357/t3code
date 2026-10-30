// @effect-diagnostics nodeBuiltinImport:off - verifies disposable home layout on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  SandboxError,
  assertSafeSandboxPaths,
  copyTemplateHome,
  createIsolatedServerEnv,
  createServerArgs,
  parseSandboxArgs,
  shouldCopyTemplatePath,
} from "./v2-sandbox.ts";

describe("v2 sandbox arguments", () => {
  it("parses one or two explicit loopback sandbox ports", () => {
    expect(
      parseSandboxArgs([
        "run",
        "--source-home",
        "/data/jobs/example/copied-home",
        "--sandbox-root",
        "/data/jobs/example/sandbox",
        "--port",
        "15431",
        "--port",
        "15432",
        "--cwd",
        "/data/jobs/example/repo",
      ]),
    ).toEqual({
      sourceHome: "/data/jobs/example/copied-home",
      sandboxRoot: "/data/jobs/example/sandbox",
      ports: [15431, 15432],
      cwd: "/data/jobs/example/repo",
      readyTimeoutMs: 120_000,
    });
  });

  it("requires an empty or copied home and unique ports", () => {
    expect(() => parseSandboxArgs(["run", "--empty", "--sandbox-root", "/tmp/sandbox"])).toThrow(
      SandboxError,
    );
    expect(() =>
      parseSandboxArgs([
        "run",
        "--empty",
        "--sandbox-root",
        "/tmp/sandbox",
        "--port",
        "15431",
        "--port",
        "15431",
      ]),
    ).toThrow("Ports must be unique");
  });
});

describe("v2 sandbox homes", () => {
  it("rejects live home paths and overlapping source/root paths", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "v2-sandbox-paths-"));
    try {
      const homeDir = NodePath.join(root, "user");
      const live = NodePath.join(homeDir, ".t3");
      await NodeFSP.mkdir(NodePath.join(live, "copied"), { recursive: true });

      expect(() =>
        assertSafeSandboxPaths({
          sourceHome: NodePath.join(live, "copied"),
          sandboxRoot: NodePath.join(root, "sandbox"),
          homeDir,
        }),
      ).toThrow("overlaps live T3 data");
      expect(() =>
        assertSafeSandboxPaths({
          sourceHome: undefined,
          sandboxRoot: NodePath.join(live, "sandbox"),
          homeDir,
        }),
      ).toThrow("sandbox root");
      expect(() =>
        assertSafeSandboxPaths({
          sourceHome: NodePath.join(root, "template"),
          sandboxRoot: NodePath.join(root, "template", "sandbox"),
          homeDir,
        }),
      ).toThrow("must not contain one another");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("copies data but not identity, ownership, runtime, cache or log state", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "v2-sandbox-copy-"));
    const source = NodePath.join(root, "template");
    const destination = NodePath.join(root, "home-1");
    try {
      for (const path of [
        "userdata/state.sqlite",
        "userdata/settings.json",
        "userdata/attachments/file.txt",
        "userdata/environment-id",
        "userdata/server-runtime.json",
        "userdata/server-owner.sqlite",
        "userdata/logs/server.log",
        "userdata/browser-artifacts/frame.png",
        "caches/provider.json",
        "runtime/version",
        "worktrees/project/file.txt",
      ]) {
        await NodeFSP.mkdir(NodePath.dirname(NodePath.join(source, path)), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(source, path), path);
      }

      expect(shouldCopyTemplatePath(source, NodePath.join(source, "userdata/state.sqlite"))).toBe(
        true,
      );
      expect(
        shouldCopyTemplatePath(source, NodePath.join(source, "userdata/server-runtime.json")),
      ).toBe(false);

      await copyTemplateHome(source, destination);
      expect(NodeFS.existsSync(NodePath.join(destination, "userdata/state.sqlite"))).toBe(true);
      expect(NodeFS.existsSync(NodePath.join(destination, "userdata/settings.json"))).toBe(true);
      expect(NodeFS.existsSync(NodePath.join(destination, "userdata/attachments/file.txt"))).toBe(
        true,
      );
      for (const path of [
        "userdata/environment-id",
        "userdata/server-runtime.json",
        "userdata/server-owner.sqlite",
        "userdata/logs/server.log",
        "userdata/browser-artifacts/frame.png",
        "caches/provider.json",
        "runtime/version",
        "worktrees/project/file.txt",
      ]) {
        expect(NodeFS.existsSync(NodePath.join(destination, path))).toBe(false);
      }
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("removes inherited launch configuration", () => {
    const env = createIsolatedServerEnv({
      PATH: "/bin",
      T3CODE_HOME: "/home/person/.t3",
      T3CODE_PORT: "4777",
      T3CODE_HOST: "0.0.0.0",
      VITE_HTTP_URL: "http://live.example",
      T3CODE_DEV_AUTH_TOKEN: "secret",
      T3_SERVICE_LAUNCHER_CONTEXT: "managed",
    });
    expect(env.PATH).toBe("/bin");
    expect(env.T3CODE_TELEMETRY_ENABLED).toBe("false");
    for (const key of [
      "T3CODE_HOME",
      "T3CODE_PORT",
      "T3CODE_HOST",
      "VITE_HTTP_URL",
      "T3CODE_DEV_AUTH_TOKEN",
      "T3_SERVICE_LAUNCHER_CONTEXT",
    ]) {
      expect(env[key]).toBeUndefined();
    }
  });

  it("passes the server cwd as the CLI positional, never as a flag", () => {
    const args = createServerArgs({
      home: "/data/jobs/example/home-1",
      port: 15431,
      cwd: "/data/jobs/example/worktree",
    });
    expect(args).not.toContain("--cwd");
    expect(args.slice(-1)).toEqual(["/data/jobs/example/worktree"]);
    expect(args).toContain("127.0.0.1");
  });
});
