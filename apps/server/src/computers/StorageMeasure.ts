// @effect-diagnostics nodeBuiltinImport:off - a bounded size scan needs lstat and incremental opendir reads.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { StorageSize } from "@t3tools/contracts";

/**
 * Bytes under one folder, measured the way `du -x` measures: allocated space (so sparse files cost
 * what they occupy), one count per hard-linked file, links not followed, nothing across onto another
 * filesystem. Files with several links are also summed separately (`sharedBytes`): another folder
 * may count the same bytes, which a total over many folders must say rather than hide.
 *
 * The scan is bounded by an entry budget and a deadline; when either runs out the result says it is
 * a lower bound. It never runs on a request: the background measurer in `Storage.ts` calls it.
 */
export interface TreeBudget {
  readonly entries: number;
  readonly deadlineMs: number;
}
export const DEFAULT_TREE_BUDGET: TreeBudget = { entries: 400_000, deadlineMs: 30_000 };

export interface TreeSize {
  readonly allocatedBytes: number;
  readonly logicalBytes: number;
  readonly sharedBytes: number;
  readonly files: number;
  readonly complete: boolean;
  /** `logical` when the platform reports no allocated blocks (Windows). */
  readonly basis: "allocated" | "logical";
}

const YIELD_EVERY = 256;
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** `null` when the folder itself cannot be read. */
export async function measureTree(
  root: string,
  budget: TreeBudget = DEFAULT_TREE_BUDGET,
  signal?: AbortSignal,
): Promise<TreeSize | null> {
  const started = Date.now();
  const top = await NodeFSP.lstat(root).catch(() => null);
  if (!top) return null;
  let allocated = 0,
    logical = 0,
    shared = 0,
    files = 0,
    visited = 0,
    complete = true,
    blocksKnown = true;
  const sizeOf = (stats: { blocks?: number; size: number }) => {
    if (typeof stats.blocks === "number") return stats.blocks * 512;
    blocksKnown = false;
    return stats.size;
  };
  const seen = new Set<string>();
  const stack = [root];
  allocated += sizeOf(top);
  scan: while (stack.length) {
    const directory = stack.pop()!;
    const handle = await NodeFSP.opendir(directory).catch(() => null);
    if (!handle) {
      // A folder that cannot be listed at all has no size to report, not a size of zero.
      if (directory === root) return null;
      complete = false;
      continue;
    }
    try {
      for (;;) {
        const entry = await handle.read().catch(() => null);
        if (!entry) break;
        visited++;
        if (
          visited > budget.entries ||
          Date.now() - started > budget.deadlineMs ||
          signal?.aborted
        ) {
          complete = false;
          break scan;
        }
        if (visited % YIELD_EVERY === 0) await yieldToLoop();
        const child = NodePath.join(directory, entry.name);
        const stats = await NodeFSP.lstat(child).catch(() => null);
        if (!stats) {
          complete = false;
          continue;
        }
        if (stats.dev !== top.dev) continue;
        if (stats.isSymbolicLink()) {
          allocated += sizeOf(stats);
          continue;
        }
        if (stats.isDirectory()) {
          allocated += sizeOf(stats);
          stack.push(child);
          continue;
        }
        if (!stats.isFile()) continue;
        if (stats.nlink > 1) {
          const key = `${stats.dev}:${stats.ino}`;
          if (seen.has(key)) continue;
          seen.add(key);
          shared += sizeOf(stats);
        }
        allocated += sizeOf(stats);
        logical += stats.size;
        files++;
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  return {
    allocatedBytes: allocated,
    logicalBytes: logical,
    sharedBytes: shared,
    files,
    complete,
    basis: blocksKnown ? "allocated" : "logical",
  };
}

export const sizeOfTree = (tree: TreeSize | null, at: number): StorageSize =>
  tree
    ? {
        bytes: tree.allocatedBytes,
        complete: tree.complete,
        measuredAt: at,
        basis: tree.basis,
        sharedBytes: tree.sharedBytes,
      }
    : { bytes: null, complete: false, measuredAt: at, basis: "unavailable" };

/** What a path with no measurement yet says: unknown, never zero. */
export const UNMEASURED: StorageSize = {
  bytes: null,
  complete: false,
  measuredAt: null,
  basis: "unavailable",
};
