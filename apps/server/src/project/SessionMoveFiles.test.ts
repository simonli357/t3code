// @effect-diagnostics nodeBuiltinImport:off
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Files from "./SessionMoveFiles.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

const temporary: string[] = [];
async function root() {
  const value = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-native-move-files-"));
  temporary.push(value);
  return value;
}
afterEach(async () => {
  for (const value of temporary.splice(0))
    await NodeFSP.rm(value, { recursive: true, force: true });
});

describe("native move files", () => {
  it("returns to a job with nested initialized submodules while retaining their source and Git metadata", async () => {
    const directory = await root();
    const init = async (name: string) => {
      const cwd = NodePath.join(directory, name);
      await NodeFSP.mkdir(cwd);
      await Files.git(cwd, ["init", "--initial-branch=main"]);
      await Files.git(cwd, ["config", "core.autocrlf", "false"]);
      await Files.git(cwd, ["config", "core.longpaths", "true"]);
      await Files.git(cwd, ["config", "user.name", "Test"]);
      await Files.git(cwd, ["config", "user.email", "test@local"]);
      await NodeFSP.writeFile(NodePath.join(cwd, "file.txt"), "original\n");
      await NodeFSP.writeFile(NodePath.join(cwd, ".gitignore"), "ignored.txt\n");
      await Files.git(cwd, ["add", "."]);
      await Files.git(cwd, ["commit", "-m", "initial"]);
      return cwd;
    };
    const leaf = await init("leaf");
    const module = await init("module");
    const primary = await init("primary");
    for (const [cwd, source] of [
      [module, leaf],
      [primary, module],
    ] as const) {
      await Files.git(cwd, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        source,
        "module",
      ]);
      await Files.git(cwd, ["commit", "-am", "add module"]);
    }
    const job = NodePath.join(directory, "job");
    const cwd = NodePath.join(job, "repo");
    const staging = NodePath.join(job, "tmp", "return");
    await Files.git(primary, ["worktree", "add", "--detach", cwd, "HEAD"]);
    await Files.git(cwd, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "update",
      "--init",
      "--recursive",
    ]);
    for (const relative of ["module", "module/module"]) {
      const sub = NodePath.join(cwd, relative);
      await NodeFSP.writeFile(NodePath.join(sub, "file.txt"), "staged\n");
      await Files.git(sub, ["add", "file.txt"]);
      await NodeFSP.writeFile(NodePath.join(sub, "file.txt"), "unstaged\n");
      await NodeFSP.writeFile(NodePath.join(sub, "ignored.txt"), "unique build");
    }
    await Files.parkReturningWorkspace(cwd, job, staging, "return");
    // Replay repair after an interruption before the final marker was written.
    await NodeFSP.unlink(NodePath.join(staging, "workspace-parked"));
    await Files.parkReturningWorkspace(cwd, job, staging, "return");
    await Files.restoreMoveWorkspace({
      projectRoot: primary,
      cwd,
      staging,
      requestId: "return",
      workspace: await Files.inspectMoveWorkspace(primary),
      files: [],
    });
    await Files.git(cwd, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "update",
      "--init",
      "--recursive",
    ]);
    await Files.parkReturningWorkspace(cwd, job, staging, "return");
    const saved = NodePath.join(job, "previous", "return");
    for (const relative of ["module", "module/module"]) {
      const sub = NodePath.join(saved, relative);
      expect(await Files.git(sub, ["show", ":file.txt"])).toBe("staged\n");
      expect(await NodeFSP.readFile(NodePath.join(sub, "file.txt"), "utf8")).toBe("unstaged\n");
      expect(await NodeFSP.readFile(NodePath.join(sub, "ignored.txt"), "utf8")).toBe(
        "unique build",
      );
      expect(
        (await Files.git(sub, ["rev-parse", "--show-toplevel"])).trim().replaceAll("\\", "/"),
      ).toBe(sub.replaceAll("\\", "/"));
      expect(await Files.git(NodePath.join(cwd, relative), ["status", "--porcelain"])).toBe("");
    }
    expect(await Files.git(module, ["status", "--porcelain"])).toBe("");
    expect(await Files.git(leaf, ["status", "--porcelain"])).toBe("");
  });
  it("parks an inactive returning job once without losing staged or ignored files", async () => {
    const directory = await root();
    const primary = NodePath.join(directory, "primary");
    const job = NodePath.join(directory, "job");
    const cwd = NodePath.join(job, "repo");
    const staging = NodePath.join(job, "tmp", "transfer");
    await NodeFSP.mkdir(primary);
    await Files.git(primary, ["init", "-q"]);
    await Files.git(primary, ["config", "user.email", "test@local"]);
    await Files.git(primary, ["config", "user.name", "Test"]);
    await NodeFSP.writeFile(NodePath.join(primary, ".gitignore"), "ignored.txt\n");
    await Files.git(primary, ["add", "."]);
    await Files.git(primary, ["commit", "-qm", "base"]);
    await Files.git(primary, ["worktree", "add", "--detach", cwd, "HEAD"]);
    await NodeFSP.writeFile(NodePath.join(cwd, "ignored.txt"), "keep old build");
    await NodeFSP.writeFile(NodePath.join(cwd, "staged.txt"), "keep old source");
    await Files.git(cwd, ["add", "staged.txt"]);
    await Files.parkReturningWorkspace(cwd, job, staging, "return-1");
    await Files.git(primary, ["worktree", "add", "--detach", cwd, "HEAD"]);
    await Files.parkReturningWorkspace(cwd, job, staging, "return-1");
    const saved = NodePath.join(job, "previous", "return-1");
    expect(await NodeFSP.readFile(NodePath.join(saved, "ignored.txt"), "utf8")).toBe(
      "keep old build",
    );
    expect(await Files.git(saved, ["show", ":staged.txt"])).toBe("keep old source");
    expect(await Files.git(cwd, ["status", "--porcelain"])).toBe("");
  });
  it("copies complete multi-chunk native data, verifies it, and detects corruption", async () => {
    const directory = await root();
    const source = NodePath.join(directory, "native.jsonl");
    const bytes = Buffer.alloc(Files.MOVE_CHUNK_BYTES * 2 + 71, 13);
    bytes.set(Buffer.from('{"type":"compaction","state":"preserve exactly"}\n'));
    await NodeFSP.writeFile(source, bytes);
    const staging = NodePath.join(directory, "out");
    const file = await Files.copyMoveFile({
      source,
      sourceRoot: directory,
      staging,
      kind: "native",
      name: "session.jsonl",
    });
    const incoming = NodePath.join(directory, "in");
    for (let offset = 0; offset < file.bytes; offset += Files.MOVE_CHUNK_BYTES)
      await Files.writeMoveChunk(
        incoming,
        file,
        offset,
        await Files.readMoveChunk(staging, file, offset),
      );
    await Files.verifyMoveFiles(incoming, [file]);
    const home = NodePath.join(directory, "provider");
    await NodeFSP.mkdir(home);
    await Files.installMoveFile(incoming, file, home);
    expect(await NodeFSP.readFile(NodePath.join(home, file.name))).toEqual(bytes);
    await Files.writeMoveChunk(incoming, file, 0, Buffer.from("corrupt").toString("base64"));
    await expect(Files.verifyMoveFiles(incoming, [file])).rejects.toThrow("verification");
  });
  it("refuses path escapes, symlinks and overwriting independent provider data", async () => {
    const directory = await root();
    expect(() => Files.contained(directory, "../outside")).toThrow();
    expect(() => Files.contained(directory, "C:\\Users\\another")).toThrow();
    const source = NodePath.join(directory, "source");
    await NodeFSP.writeFile(source, "full native state");
    const file = await Files.copyMoveFile({
      source,
      sourceRoot: directory,
      staging: NodePath.join(directory, "stage"),
      kind: "native",
      name: "session.jsonl",
    });
    const provider = NodePath.join(directory, "provider");
    await NodeFSP.mkdir(provider);
    await NodeFSP.writeFile(NodePath.join(provider, file.name), "another existing session");
    await expect(
      Files.installMoveFile(NodePath.join(directory, "stage"), file, provider),
    ).rejects.toThrow("different session data");
    expect(await NodeFSP.readFile(NodePath.join(provider, file.name), "utf8")).toBe(
      "another existing session",
    );
    // Junctions exercise the same lstat rejection without Windows symlink privileges.
    await NodeFSP.symlink(
      HostProcessPlatform.defaultValue() === "win32" ? directory : source,
      NodePath.join(directory, "link"),
      HostProcessPlatform.defaultValue() === "win32" ? "junction" : "file",
    );
    await expect(
      Files.copyMoveFile({
        source: NodePath.join(directory, "link"),
        sourceRoot: directory,
        staging: NodePath.join(directory, "stage"),
        kind: "native",
        name: "link",
      }),
    ).rejects.toThrow("symlinks");
  });
  it("restores staged, unstaged, binary and untracked changes without touching the target checkout", async () => {
    const directory = await root();
    const source = NodePath.join(directory, "source repo");
    const target = NodePath.join(directory, "target repo");
    await NodeFSP.mkdir(source);
    await Files.git(source, ["init", "-q"]);
    await Files.git(source, ["config", "user.email", "test@local"]);
    await Files.git(source, ["config", "user.name", "Test"]);
    await NodeFSP.writeFile(NodePath.join(source, "code.txt"), "base\n");
    await NodeFSP.writeFile(NodePath.join(source, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    await Files.git(source, ["add", "."]);
    await Files.git(source, ["commit", "-qm", "base"]);
    await Files.git(directory, ["clone", "-q", source, target]);
    await NodeFSP.writeFile(NodePath.join(source, "code.txt"), "staged\n");
    await Files.git(source, ["add", "code.txt"]);
    await NodeFSP.writeFile(NodePath.join(source, "code.txt"), "working\n\n");
    await NodeFSP.writeFile(NodePath.join(source, "binary.dat"), Buffer.from([0, 9, 8, 7, 6]));
    await NodeFSP.writeFile(NodePath.join(source, "new.txt"), "untracked\n");
    const workspace = await Files.inspectMoveWorkspace(source);
    const staging = NodePath.join(directory, "staging");
    const threadId = "native-thread";
    const checkpoint =
      "refs/t3/checkpoints/" + Buffer.from(threadId).toString("base64url") + "/turn/0";
    await Files.git(source, ["update-ref", checkpoint, workspace.head]);
    const files = await Files.captureMoveWorkspace(source, staging, false, threadId);
    const cwd = NodePath.join(directory, "moved worktree");
    await Files.restoreMoveWorkspace({
      projectRoot: target,
      cwd,
      staging,
      workspace,
      files,
      threadId,
    });
    expect((await Files.git(cwd, ["rev-parse", checkpoint])).trim()).toBe(workspace.head);
    expect(await NodeFSP.readFile(NodePath.join(cwd, "code.txt"), "utf8")).toBe("working\n\n");
    expect(await Files.git(cwd, ["show", ":code.txt"])).toBe("staged\n");
    expect(await NodeFSP.readFile(NodePath.join(cwd, "binary.dat"))).toEqual(
      Buffer.from([0, 9, 8, 7, 6]),
    );
    expect(await NodeFSP.readFile(NodePath.join(cwd, "new.txt"), "utf8")).toBe("untracked\n");
    expect(await Files.git(target, ["status", "--porcelain"])).toBe("");
    // Simulate a crash after patches were applied, before the final marker.
    await NodeFSP.rm(NodePath.join(staging, "workspace-restored"));
    await Files.restoreMoveWorkspace({
      projectRoot: target,
      cwd,
      staging,
      workspace,
      files,
      threadId,
    });
    expect(await NodeFSP.readFile(NodePath.join(cwd, "code.txt"), "utf8")).toBe("working\n\n");
  });
});
