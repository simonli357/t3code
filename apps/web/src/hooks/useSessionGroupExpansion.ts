import { toggleSessionGroupKey } from "@t3tools/client-runtime/state/session-organization";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "./useLocalStorage";

/** Opened groups use a separate key: the older collapsed-groups key had opposite semantics. */
const EXPANDED_MASTERS_STORAGE_KEY = "t3code:sidebar:expanded-masters";

const ExpandedMasters = Schema.Array(Schema.String);
const NONE_EXPANDED: ReadonlyArray<string> = [];

export function useSessionGroupExpansion() {
  const [keys, setKeys] = useLocalStorage(
    EXPANDED_MASTERS_STORAGE_KEY,
    NONE_EXPANDED,
    ExpandedMasters,
  );
  const expanded = new Set(keys);
  const toggle = (masterKey: string) =>
    setKeys((current) => toggleSessionGroupKey(current, masterKey));
  return { expanded, toggle } as const;
}
