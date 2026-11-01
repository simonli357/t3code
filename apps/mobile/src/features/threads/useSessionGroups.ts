import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { toggleSessionGroupKey } from "@t3tools/client-runtime/state/session-organization";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

export function useSessionGroups() {
  const state = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const expanded = new Set(
    AsyncResult.isSuccess(state) ? (state.value.expandedSessionMasters ?? []) : [],
  );
  const finished = new Set(
    AsyncResult.isSuccess(state) ? (state.value.expandedFinishedSessionGroups ?? []) : [],
  );
  return {
    expanded,
    finished,
    toggle: (key: string) =>
      save({
        transform: (current) => ({
          expandedSessionMasters: toggleSessionGroupKey(current.expandedSessionMasters ?? [], key),
        }),
      }),
    toggleFinished: (key: string) =>
      save({
        transform: (current) => ({
          expandedFinishedSessionGroups: toggleSessionGroupKey(
            current.expandedFinishedSessionGroups ?? [],
            key,
          ),
        }),
      }),
  };
}
