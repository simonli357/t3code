import type { ComputerInspection, ComputerInspectInput, EnvironmentId } from "@t3tools/contracts";
import { failure } from "./computersView";

export const RESULTS_PAGE_SIZE = 200;
export interface ComputerSearchPage {
  readonly result: ComputerInspection | null;
  readonly error: string | null;
}

/** Holds only the pages explicitly requested for the current search. */
export function createComputersSearch(
  read: (id: EnvironmentId, input: ComputerInspectInput) => Promise<ComputerInspection>,
) {
  let state: {
    pages: Readonly<Record<string, ComputerSearchPage>>;
    loading: boolean;
  } = { pages: {}, loading: false };
  let generation = 0;
  let ids: readonly EnvironmentId[] = [];
  let input: ComputerInspectInput = { section: "files" };
  const listeners = new Set<() => void>();
  const publish = (next: typeof state) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const next = async () => {
    if (state.loading) return;
    const current = generation;
    const previous = state.pages;
    publish({ ...state, loading: true });
    await Promise.all(
      ids.map(async (id) => {
        const before = previous[id]?.result;
        if (before && before.files.length >= before.totalFiles) return;
        try {
          let result = await read(id, {
            ...input,
            refresh: !before && input.refresh === true,
            offset: before?.files.length ?? 0,
            limit: RESULTS_PAGE_SIZE,
          });
          if (current !== generation) return;
          if (before && before.indexedAt !== result.indexedAt) {
            // A rebuilt index has different offsets; start this computer again.
            result = await read(id, {
              ...input,
              refresh: false,
              offset: 0,
              limit: RESULTS_PAGE_SIZE,
            });
            if (current !== generation) return;
          } else if (before) {
            result = { ...result, files: [...before.files, ...result.files] };
          }
          publish({ ...state, pages: { ...state.pages, [id]: { result, error: null } } });
        } catch (error) {
          if (current !== generation) return;
          publish({
            ...state,
            pages: { ...state.pages, [id]: { result: before ?? null, error: failure(error) } },
          });
        }
      }),
    );
    if (current === generation) publish({ ...state, loading: false });
  };
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    search: (computers: readonly EnvironmentId[], request: ComputerInspectInput) => {
      generation++;
      ids = computers;
      input = request;
      publish({ pages: {}, loading: false });
      return next();
    },
    invalidate: () => {
      generation++;
    },
    next,
  };
}
