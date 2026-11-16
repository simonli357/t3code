import type { AutosaveState } from "@t3tools/client-runtime/state/autosave";
import { cn } from "~/lib/utils";

const text = {
  loading: "Loading…",
  offline: "Not connected",
  idle: "Changes save automatically",
  editing: "Not saved yet",
  saving: "Saving…",
  saved: "Saved",
  failed: "Not saved",
  conflict: "Not saved",
} as const;

/** How far a page that saves by itself got with the latest change. */
export function SaveState({
  phase,
}: {
  phase: AutosaveState<unknown>["phase"] | "loading" | "offline";
}) {
  return (
    <span
      role="status"
      className={cn(
        "text-xs",
        phase === "failed" || phase === "conflict" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {text[phase]}
    </span>
  );
}
