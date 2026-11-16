/**
 * Saves a versioned document as it is edited, so a page needs no Save button.
 *
 * `saved` is the newest stored value seen, `baseline` the stored value the edits sit on and
 * `policy` what the page shows. One save runs at a time. A save that finds a newer stored
 * version reads it and applies the edits on top of it; when the newer version changed one of
 * the edited values too, the save stops and the page asks, so nothing stored elsewhere is
 * overwritten unseen.
 */
export interface AutosaveDraft<P> {
  readonly saved: P | null;
  readonly baseline: P | null;
  readonly policy: P | null;
}
export interface AutosaveState<P> extends AutosaveDraft<P> {
  /**
   * `editing` while an edit waits for its pause or for its field to be left, `saving` while it
   * is being stored. `conflict` waits for `resolve`.
   */
  readonly phase: "idle" | "editing" | "saving" | "saved" | "failed" | "conflict";
  /** Why the edits are not stored, when `failed`. */
  readonly error: string | null;
}
export type AutosaveResult<P> =
  | { readonly saved: P }
  | { readonly conflict: true }
  | { readonly error: string };
export interface AutosaveOptions<P> {
  /** Stores `policy` if the stored version is still `baseline`'s. */
  readonly save: (policy: P, baseline: P) => Promise<AutosaveResult<P>>;
  /** The newest stored value, read after a save found a newer version; null when unreadable. */
  readonly read: () => Promise<P | null>;
  readonly dirty: (baseline: P, policy: P) => boolean;
  /** The edits `mine` made to `base`, applied onto `theirs`; `collides` when `theirs` changed one too. */
  readonly rebase: (
    base: P,
    mine: P,
    theirs: P,
  ) => { readonly policy: P; readonly collides: boolean };
  /** Why `policy` cannot be stored as it is, such as a number out of range. */
  readonly invalid?: (policy: P) => string | null;
}
export type Autosave<P> = ReturnType<typeof createAutosave<P>>;

export function createAutosave<P>(options: AutosaveOptions<P>) {
  let state: AutosaveState<P> = {
    saved: null,
    baseline: null,
    policy: null,
    phase: "idle",
    error: null,
  };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving = false;
  // An edit asked to be stored while a save was in flight.
  let again = false;
  const set = (next: Partial<AutosaveState<P>>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const isDirty = () =>
    state.baseline !== null && state.policy !== null && options.dirty(state.baseline, state.policy);
  const run = async () => {
    clearTimeout(timer);
    timer = undefined;
    // The save in flight stores newer edits when it returns.
    if (saving) {
      again = true;
      return;
    }
    saving = true;
    try {
      for (let conflicts = 0; ;) {
        let { baseline, policy } = state;
        const { saved } = state;
        if (!saved || !baseline || !policy) return;
        if (saved !== baseline) {
          const rebased = options.rebase(baseline, policy, saved);
          if (rebased.collides) return set({ phase: "conflict", error: null });
          [baseline, policy] = [saved, rebased.policy];
          set({ baseline, policy });
        }
        if (!options.dirty(baseline, policy))
          return set({ phase: state.phase === "idle" ? "idle" : "saved", error: null });
        const reason = options.invalid?.(policy) ?? null;
        if (reason) return set({ phase: "failed", error: reason });
        set({ phase: "saving", error: null });
        const result = await options.save(policy, baseline);
        if ("error" in result) return set({ phase: "failed", error: result.error });
        if ("saved" in result) {
          // Edits made while the save was in flight sit on what was submitted, and stay.
          const current = state.policy ?? policy;
          set({
            saved: result.saved,
            baseline: result.saved,
            policy: options.rebase(policy, current, result.saved).policy,
          });
          // A newer edit still waiting for its pause or its field is stored when that ends.
          if (state.phase === "editing" && !again) return;
          again = false;
          continue;
        }
        if (++conflicts > 2)
          return set({ phase: "failed", error: "These settings keep changing elsewhere." });
        const newest = await options.read();
        if (!newest)
          return set({
            phase: "failed",
            error: "Changed elsewhere, and the newest values could not be read.",
          });
        set({ saved: newest });
      }
    } finally {
      saving = false;
      again = false;
    }
  };
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** A read of the stored value arrived: an untouched page follows it, edits are kept. */
    receive(saved: P) {
      if (!isDirty()) return set({ saved, baseline: saved, policy: saved });
      set({ saved });
      // Edits that could not be stored, such as while offline, are tried again.
      if (state.phase === "failed") void run();
    },
    /** Replaces everything with a stored value, such as after a revert. */
    adopt(saved: P) {
      clearTimeout(timer);
      timer = undefined;
      set({ saved, baseline: saved, policy: saved, phase: "idle", error: null });
    },
    /**
     * Changes what the page shows and stores it after `pause` ms: none for a switch, some for
     * typing. With `null` it waits for `flush`, for a value that must not be stored half typed.
     */
    edit(update: (policy: P) => P, pause: number | null = 0) {
      if (!state.policy) return;
      const conflict = state.phase === "conflict";
      set({ policy: update(state.policy), ...(conflict ? {} : { phase: "editing" }) });
      clearTimeout(timer);
      timer = conflict || pause === null ? undefined : setTimeout(() => void run(), pause);
    },
    /** Stores a waiting edit now: on leaving a field, or the page. */
    flush() {
      if (state.phase === "editing") void run();
    },
    retry: () => void run(),
    /** Ends a conflict: keep the edits on the newer stored value, or drop them for it. */
    resolve(keep: boolean) {
      const { saved, baseline, policy } = state;
      if (!saved || !baseline || !policy) return;
      if (!keep) return set({ baseline: saved, policy: saved, phase: "idle", error: null });
      set({
        baseline: saved,
        policy: options.rebase(baseline, policy, saved).policy,
        phase: "editing",
      });
      void run();
    },
  };
}

/** Structural equality of stored JSON values; the order of an object's keys does not matter. */
export function sameStoredValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const [left, right] = [a as Record<string, unknown>, b as Record<string, unknown>];
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  return (
    keys.length === Object.keys(right).filter((key) => right[key] !== undefined).length &&
    keys.every((key) => sameStoredValue(left[key], right[key]))
  );
}
