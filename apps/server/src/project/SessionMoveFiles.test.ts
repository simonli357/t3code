// @effect-diagnostics nodeBuiltinImport:off
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Files from "./SessionMoveFiles.ts";

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
    await NodeFSP.symlink(source, NodePath.join(directory, "link"));
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
