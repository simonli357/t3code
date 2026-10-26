import { toggleSessionGroupKey } from "@t3tools/client-runtime/state/session-organization";
import * as Schema from "effect/Schema";
import { useCallback, useMemo } from "react";
import { useLocalStorage } from "./useLocalStorage";

/**
 * Master groups start collapsed, so the only thing worth remembering is which
 * ones the user opened. The key is new on purpose: the retired
 * `sidebar-collapsed-masters` list meant the opposite (an empty list kept every
 * group open), and reading it as "opened" would flip each saved choice. A fresh
 * key also keeps old defaults collapsed without a migration that could undo a
 * choice made later.
 */
export const EXPANDED_MASTERS_STORAGE_KEY = "t3code:sidebar:expanded-masters";

const ExpandedMasters = Schema.Array(Schema.String);
const NONE_EXPANDED: ReadonlyArray<string> = [];

export function useSessionGroupExpansion() {
  const [keys, setKeys] = useLocalStorage(
    EXPANDED_MASTERS_STORAGE_KEY,
    NONE_EXPANDED,
    ExpandedMasters,
  );
  const expanded = useMemo(() => new Set(keys), [keys]);
  const toggle = useCallback(
    (masterKey: string) => setKeys((current) => toggleSessionGroupKey(current, masterKey)),
    [setKeys],
  );
  return { expanded, toggle } as const;
}
