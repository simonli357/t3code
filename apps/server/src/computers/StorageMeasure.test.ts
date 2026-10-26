// @effect-diagnostics nodeBuiltinImport:off - the tests build real folders with hard links and sparse files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { measureTree, sizeOfTree, UNMEASURED } from "./StorageMeasure.ts";

let root: string;
beforeEach(async () => {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-storage-measure-"));
});
afterEach(async () => {
  await NodeFSP.rm(root, { recursive: true, force: true });
});

const write = (name: string, bytes: number) =>
  NodeFSP.writeFile(NodePath.join(root, name), Buffer.alloc(bytes, 1));

describe("measuring a folder", () => {
  it("counts a hard-linked file once and reports its bytes as shared", async () => {
    await write("one.bin", 256 * 1024);
    await NodeFSP.link(NodePath.join(root, "one.bin"), NodePath.join(root, "two.bin"));
    await write("plain.bin", 64 * 1024);
    const tree = (await measureTree(root))!;
    // 256 KiB (once) plus 64 KiB, not 576 KiB; blocks make the real figure a little larger.
    expect(tree.logicalBytes).toBe(320 * 1024);
    expect(tree.allocatedBytes).toBeGreaterThanOrEqual(320 * 1024);
    expect(tree.allocatedBytes).toBeLessThan(400 * 1024);
    expect(tree.sharedBytes).toBeGreaterThanOrEqual(256 * 1024);
    expect(tree.sharedBytes).toBeLessThan(300 * 1024);
    expect(tree.files).toBe(2);
    expect(tree.complete).toBe(true);
  });

  it("charges a sparse file for the space it occupies, not for its length", async () => {
    const sparse = NodePath.join(root, "sparse.img");
    const handle = await NodeFSP.open(sparse, "w");
    await handle.truncate(64 * 1024 * 1024);
    await handle.close();
    const tree = (await measureTree(root))!;
    expect(tree.logicalBytes).toBe(64 * 1024 * 1024);
    expect(tree.allocatedBytes).toBeLessThan(1024 * 1024);
    expect(tree.basis).toBe("allocated");
  });

  it("does not follow links out of the folder", async () => {
    const outside = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-storage-outside-"));
    try {
      await NodeFSP.writeFile(NodePath.join(outside, "big.bin"), Buffer.alloc(512 * 1024, 2));
      await NodeFSP.symlink(outside, NodePath.join(root, "link"));
      await write("inside.bin", 1024);
      const tree = (await measureTree(root))!;
      expect(tree.logicalBytes).toBe(1024);
      expect(tree.files).toBe(1);
    } finally {
      await NodeFSP.rm(outside, { recursive: true, force: true });
    }
  });

  it("says its size is a lower bound when the entry budget runs out", async () => {
    for (let index = 0; index < 20; index++) await write(`file-${index}.bin`, 4096);
    const tree = (await measureTree(root, { entries: 5, deadlineMs: 10_000 }))!;
    expect(tree.complete).toBe(false);
    expect(tree.files).toBeLessThan(20);
    expect(sizeOfTree(tree, 123)).toMatchObject({ complete: false, measuredAt: 123 });
  });

  it("returns nothing, not zero, for a folder that cannot be listed", async () => {
    expect(await measureTree(NodePath.join(root, "missing"))).toBeNull();
    expect(sizeOfTree(null, 5)).toEqual({
      bytes: null,
      complete: false,
      measuredAt: 5,
      basis: "unavailable",
    });
    expect(UNMEASURED.bytes).toBeNull();
  });

  it("measures an empty folder as the small size it is", async () => {
    const tree = (await measureTree(root))!;
    expect(tree.logicalBytes).toBe(0);
    expect(tree.files).toBe(0);
    expect(tree.complete).toBe(true);
  });
});
