import {
  MODEL_SCORES,
  accountSupportsRoutingProfile,
  automaticModelAllowed,
  defaultModelRoutingPolicy,
  routingEffortOptionId,
  type ModelRoutingPolicy,
  type ModelRoutingRequest,
  type ModelRoutingSnapshot,
  type RoutingCell,
  type RoutingProfile,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";

export function modelFailureMessage(cause: Cause.Cause<unknown> | undefined) {
  if (!cause) return "Request failed.";
  const failure = Cause.squash(cause);
  return failure instanceof Error ? failure.message : "Request failed.";
}

export const modelProfileLabel = (profile: RoutingProfile) =>
  `${profile.model} / ${profile.effort}`;
export const modelPreviewKey = (
  policy: ModelRoutingPolicy,
  request: ModelRoutingRequest,
  connection: string,
) => JSON.stringify({ policy, request, connection });

/** Uses the selected environment's reachable web origin, never a baked-in localhost. */
export function modelEditorUrl(displayUrl: string | null, environmentId: string) {
  if (!displayUrl || !/^https?:|^wss?:/i.test(displayUrl)) return null;
  const url = new URL(displayUrl);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  url.pathname = "/settings/model-selection";
  url.search = `?machine=${encodeURIComponent(environmentId)}`;
  url.hash = "";
  return url.toString();
}

export type ModelDriver = "codex" | "claudeAgent";
export const MODEL_DRIVERS = ["codex", "claudeAgent"] as const;
export const modelDriverLabel = (driver: ModelDriver) => (driver === "codex" ? "Codex" : "Claude");

function splitModelName(slug: string) {
  const vendor = /^(gpt|claude)-/i.exec(slug)?.[1];
  const words = slug.replace(/^(gpt|claude)-/i, "").split("-");
  const isVersion = (word: string) => /^\d+(\.\d+)?$/.test(word);
  const names = words.filter((w) => w && !isVersion(w));
  if (!names.length && vendor) names.push(vendor.toLowerCase() === "gpt" ? "GPT" : "Claude");
  return {
    name: names.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
    version: words.filter(isVersion).join("."),
  };
}
/** "gpt-6.1-sol" → "Sol 6.1", "claude-sonnet-5-5" → "Sonnet 5.5". */
export function modelDisplayName(slug: string) {
  const { name, version } = splitModelName(slug);
  return [name, version].filter(Boolean).join(" ") || slug;
}
/** The bare name for a dense table ("Sol"), keeping the version only where two models share a name. */
export function modelShortNames(models: readonly string[]) {
  const names = models.map((slug) => splitModelName(slug).name);
  return new Map(
    models.map((slug, i) => [
      slug,
      names[i] && names.filter((n) => n === names[i]).length === 1
        ? names[i]!
        : modelDisplayName(slug),
    ]),
  );
}
export const effortDisplayName = (effort: string) => (effort === "medium" ? "med" : effort);
/** "Sol 6.1 · max": the compact form of one table entry. */
export const modelCellSummary = (cell: RoutingProfile) =>
  `${modelDisplayName(cell.model)} · ${effortDisplayName(cell.effort)}`;

/** What the connected accounts of one provider on one environment advertise. */
export interface ModelCatalog {
  /** At least one account of this provider is known (it may have been seen before a disconnect). */
  readonly known: boolean;
  /** Models that automatic selection may use. */
  readonly models: readonly string[];
  readonly efforts: (model: string) => readonly string[];
  readonly supports: (profile: RoutingProfile) => boolean;
}
export function modelCatalog(
  inventories: ModelRoutingSnapshot["inventories"],
  environmentId: string,
  driver: ModelDriver,
): ModelCatalog {
  const accounts = inventories
    .flatMap((i) => i.accounts)
    .filter((a) => a.environmentId === environmentId && a.driver === driver);
  const models = [
    ...new Set(accounts.flatMap((a) => a.models.map((m) => m.slug)).filter(automaticModelAllowed)),
  ].sort();
  return {
    known: accounts.length > 0,
    models,
    efforts: (model) => [
      ...new Set(
        accounts.flatMap((a) =>
          (a.models.find((m) => m.slug === model)?.capabilities?.optionDescriptors ?? []).flatMap(
            (o) =>
              o.type === "select" && o.id === routingEffortOptionId(driver)
                ? o.options.map((v) => v.id)
                : [],
          ),
        ),
      ),
    ],
    supports: (profile) => accounts.some((a) => accountSupportsRoutingProfile(a, profile)),
  };
}

export const modelCell = (policy: ModelRoutingPolicy, driver: ModelDriver, d: number, s: number) =>
  policy[driver].cells[d]![s]!;
const sameProfile = (a: RoutingProfile, b: RoutingProfile) =>
  a.model === b.model && a.effort === b.effort;
export const sameModelCell = (a: RoutingCell, b: RoutingCell) =>
  a === b ||
  (sameProfile(a, b) &&
    (a.alternatives?.length ?? 0) === (b.alternatives?.length ?? 0) &&
    (a.alternatives ?? []).every((alternative, i) =>
      sameProfile(alternative, b.alternatives![i]!),
    ));

/**
 * Replaces exactly one table entry. Models the entry uses are approved so the saved table
 * stays valid; no other entry changes, even if it shared this one's old value.
 */
export function setModelCell(
  policy: ModelRoutingPolicy,
  driver: ModelDriver,
  difficulty: number,
  stakes: number,
  next: RoutingCell,
): ModelRoutingPolicy {
  const table = policy[driver];
  const { alternatives = [], ...primary } = next;
  const kept = alternatives.filter((a) => !sameProfile(a, primary));
  const cell: RoutingCell = kept.length ? { ...primary, alternatives: kept } : primary;
  const approved = [...new Set([cell.model, ...kept.map((a) => a.model)])].filter(
    (m) => !table.allowedModels.includes(m),
  );
  return {
    ...policy,
    [driver]: {
      cells: table.cells.map((row, d) =>
        d === difficulty ? row.map((existing, s) => (s === stakes ? cell : existing)) : row,
      ),
      allowedModels: approved.length ? [...table.allowedModels, ...approved] : table.allowedModels,
    },
  };
}

/**
 * Choosing a model keeps the entry's reasoning when the new model offers it. Otherwise the
 * editor must ask for an explicit reasoning level; it never picks a different one silently.
 */
export function chooseModelForCell(
  cell: RoutingCell,
  model: string,
  catalog: ModelCatalog,
): { cell: RoutingCell } | { pendingModel: string; efforts: readonly string[] } {
  const offered = catalog.efforts(model);
  return offered.includes(cell.effort)
    ? { cell: { ...cell, model } }
    : { pendingModel: model, efforts: offered };
}

/** Resets one provider's table to the built-in defaults, leaving the other provider alone. */
export const resetModelTable = (policy: ModelRoutingPolicy, driver: ModelDriver) => ({
  ...policy,
  [driver]: defaultModelRoutingPolicy[driver],
});

export interface ModelCellChange {
  readonly driver: ModelDriver;
  readonly difficulty: number;
  readonly stakes: number;
}
/** Entries whose choice differs. */
export function modelCellChanges(from: ModelRoutingPolicy, to: ModelRoutingPolicy) {
  const changes: ModelCellChange[] = [];
  for (const driver of MODEL_DRIVERS)
    for (const difficulty of MODEL_SCORES)
      for (const stakes of MODEL_SCORES)
        if (
          !sameModelCell(
            modelCell(from, driver, difficulty, stakes),
            modelCell(to, driver, difficulty, stakes),
          )
        )
          changes.push({ driver, difficulty, stakes });
  return changes;
}

/**
 * The draft is edited on top of `baseline`, the saved table it started from. `saved` is the
 * newest saved table seen; it differs from `baseline` when someone else saved meanwhile.
 */
export interface ModelDraft {
  readonly saved: ModelRoutingPolicy | null;
  readonly baseline: ModelRoutingPolicy | null;
  readonly policy: ModelRoutingPolicy | null;
}
export const emptyModelDraft: ModelDraft = { saved: null, baseline: null, policy: null };
export function modelDraftChanges(draft: ModelDraft) {
  if (!draft.baseline || !draft.policy) return { cells: [], settings: false };
  return {
    cells: modelCellChanges(draft.baseline, draft.policy),
    settings: draft.baseline.maxReassessments !== draft.policy.maxReassessments,
  };
}
export function modelDraftDirty(draft: ModelDraft) {
  const changes = modelDraftChanges(draft);
  return changes.settings || changes.cells.length > 0;
}
/** Everything a screen shows about unsaved work, computed in one pass. */
export function summarizeModelDraft(draft: ModelDraft) {
  const changes = modelDraftChanges(draft);
  const dirty = changes.settings || changes.cells.length > 0;
  const { saved, baseline } = draft;
  return {
    dirty,
    /**
     * Unsaved edits sit on a table that is no longer the newest saved one. Equal versions
     * with different content mean another coordinator's table, which is just as stale.
     */
    stale:
      dirty &&
      saved !== null &&
      baseline !== null &&
      (saved.version !== baseline.version ||
        saved.maxReassessments !== baseline.maxReassessments ||
        modelCellChanges(saved, baseline).length > 0),
    count: changes.cells.length + (changes.settings ? 1 : 0),
    editedCells: (driver: ModelDriver) => changes.cells.filter((c) => c.driver === driver).length,
  };
}
export const modelDraftStale = (draft: ModelDraft) => summarizeModelDraft(draft).stale;
/** A first load or an untouched draft follows the saved table; edits are never overwritten. */
export const receiveSavedModelPolicy = (
  draft: ModelDraft,
  saved: ModelRoutingPolicy,
): ModelDraft =>
  modelDraftDirty(draft) ? { ...draft, saved } : { saved, baseline: saved, policy: saved };
/** Replaces everything with a table that was just saved, reverted to, or deliberately reloaded. */
export const adoptModelPolicy = (saved: ModelRoutingPolicy): ModelDraft => ({
  saved,
  baseline: saved,
  policy: saved,
});
export const discardModelDraft = (draft: ModelDraft) =>
  draft.saved ? adoptModelPolicy(draft.saved) : draft;
export const editModelDraft = (
  draft: ModelDraft,
  update: (policy: ModelRoutingPolicy) => ModelRoutingPolicy,
): ModelDraft => (draft.policy ? { ...draft, policy: update(draft.policy) } : draft);
/** Applies only the entries and settings the user edited onto the newer saved table. */
export function rebaseModelDraft(draft: ModelDraft): ModelDraft {
  const { saved, baseline, policy } = draft;
  if (!saved || !baseline || !policy) return draft;
  let merged = saved;
  for (const { driver, difficulty, stakes } of modelCellChanges(baseline, policy))
    merged = setModelCell(
      merged,
      driver,
      difficulty,
      stakes,
      modelCell(policy, driver, difficulty, stakes),
    );
  if (baseline.maxReassessments !== policy.maxReassessments)
    merged = { ...merged, maxReassessments: policy.maxReassessments };
  return { saved, baseline: saved, policy: merged };
}

/** A save acknowledges the submitted table, not edits made while its receipt was in flight. */
export function acknowledgeModelSave(
  draft: ModelDraft,
  submitted: ModelRoutingPolicy,
  saved: ModelRoutingPolicy,
): ModelDraft {
  return rebaseModelDraft({ saved, baseline: submitted, policy: draft.policy ?? submitted });
}
