import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";
import { appAtomRegistry } from "./atom-registry";
import { useEnvironments } from "./environments";

const collapsedMasters = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(Atom.keepAlive);
const expandedFinished = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(Atom.keepAlive);
export function toggleSessionGroup(key: string, finished = false) {
  const atom = finished ? expandedFinished : collapsedMasters;
  const next = new Set(appAtomRegistry.get(atom));
  if (next.has(key)) next.delete(key);
  else next.add(key);
  appAtomRegistry.set(atom, next);
}
export function useSessionGroupSettings() {
  const collapsed = useAtomValue(collapsedMasters);
  const finishedExpanded = useAtomValue(expandedFinished);
  const { environments } = useEnvironments();
  return useMemo(
    () => ({
      collapsed,
      finishedExpanded,
      connected: new Set(
        environments.filter((e) => e.connection.phase === "connected").map((e) => e.environmentId),
      ),
    }),
    [collapsed, finishedExpanded, environments],
  );
}
