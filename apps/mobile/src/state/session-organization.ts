import { useAtomValue } from "@effect/atom-react";
import { toggleSessionGroupKey } from "@t3tools/client-runtime/state/session-organization";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";
import { appAtomRegistry } from "./atom-registry";
import { useEnvironments } from "./environments";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "./preferences";

// Finished workers stay hidden until asked for. Unlike a group's own choice,
// this one lasts for the app session only.
const expandedFinished = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(Atom.keepAlive);
const NONE_EXPANDED: ReadonlyArray<string> = [];

/**
 * Opens or closes a master's worker group. The choice is saved with the device
 * preferences, so it survives restarts and never changes on its own. Until the
 * saved choices load the toggle does nothing, as the shelf headers do, rather
 * than guess which groups the user had open.
 */
export function toggleSessionGroup(key: string, finished = false) {
  if (finished) {
    const next = new Set(appAtomRegistry.get(expandedFinished));
    if (next.has(key)) next.delete(key);
    else next.add(key);
    appAtomRegistry.set(expandedFinished, next);
    return;
  }
  if (!AsyncResult.isSuccess(appAtomRegistry.get(mobilePreferencesAtom))) return;
  appAtomRegistry.set(updateMobilePreferencesAtom, {
    transform: (current) => ({
      expandedSessionMasters: toggleSessionGroupKey(
        current.expandedSessionMasters ?? NONE_EXPANDED,
        key,
      ),
    }),
  });
}

export function useSessionGroupSettings() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const finishedExpanded = useAtomValue(expandedFinished);
  const { environments } = useEnvironments();
  const savedExpanded = AsyncResult.isSuccess(preferences)
    ? preferences.value.expandedSessionMasters
    : undefined;
  return useMemo(
    () => ({
      expanded: new Set(savedExpanded ?? NONE_EXPANDED),
      finishedExpanded,
      connected: new Set(
        environments.filter((e) => e.connection.phase === "connected").map((e) => e.environmentId),
      ),
      computerLabels: new Map(environments.map((e) => [e.environmentId, e.label])),
    }),
    [savedExpanded, finishedExpanded, environments],
  );
}
