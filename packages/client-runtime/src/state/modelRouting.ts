import {
  MODEL_SCORES,
  accountSupportsRoutingProfile,
  defaultModelRoutingPolicy,
  modelFallback,
  modelLadder,
  routingEffortOptionId,
  type ModelRoutingPolicy,
  type ModelRoutingRequest,
  type ModelRoutingSnapshot,
  type RoutingCell,
  type RoutingProfile,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type { AutosaveOptions } from "./autosave.ts";

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
/** One letter per model, or two where a letter is shared: for a table too narrow for names. */
export function modelShortCodes(models: readonly string[]) {
  const names = modelShortNames(models);
  const letters = (slug: string, count: number) => (names.get(slug) ?? slug).slice(0, count);
  return new Map(
    models.map((slug) => [
      slug,
      letters(
        slug,
        models.filter((other) => letters(other, 1) === letters(slug, 1)).length === 1 ? 1 : 2,
      ),
    ]),
  );
}
const EFFORT_CODES: Readonly<Record<string, string>> = {
  minimal: "mn",
  low: "lo",
  medium: "md",
  high: "hi",
  xhigh: "xh",
  max: "mx",
};
/** An effort in two letters, such as "hi" or "xh". */
export const effortShortCode = (effort: string) => EFFORT_CODES[effort] ?? effort.slice(0, 2);
/** "Sol 6.1 · max": the compact form of one table entry. */
export const modelCellSummary = (cell: RoutingProfile) =>
  `${modelDisplayName(cell.model)} · ${effortDisplayName(cell.effort)}`;

/** What the connected accounts of one provider on one environment advertise. */
export interface ModelCatalog {
  /** At least one account of this provider is known (it may have been seen before a disconnect). */
  readonly known: boolean;
  /** Models the connected accounts advertise. */
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
  const models = [...new Set(accounts.flatMap((a) => a.models.map((m) => m.slug)))].sort();
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

/** Sets one table's model list. Any model ID is accepted; the save reports what no account offers. */
export const setAllowedModels = (
  policy: ModelRoutingPolicy,
  driver: ModelDriver,
  allowedModels: readonly string[],
): ModelRoutingPolicy => ({
  ...policy,
  [driver]: { ...policy[driver], allowedModels: [...new Set(allowedModels)] },
});

/** Everything in a policy besides the table entries, for comparing and carrying over edits. */
const modelSettings = (policy: ModelRoutingPolicy) => ({
  maxReassessments: policy.maxReassessments,
  ladder: modelLadder(policy),
  fallback: modelFallback(policy),
  codex: policy.codex.allowedModels,
  claudeAgent: policy.claudeAgent.allowedModels,
});
const modelSettingKeys = [
  "maxReassessments",
  "ladder",
  "fallback",
  "codex",
  "claudeAgent",
] as const;
/** The settings that differ, by name. */
function modelSettingChanges(from: ModelRoutingPolicy, to: ModelRoutingPolicy) {
  const [a, b] = [modelSettings(from), modelSettings(to)];
  return modelSettingKeys.filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
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

/** How many of each provider's table entries a page shows that are not stored yet. */
export function summarizeModelDraft(draft: {
  readonly baseline: ModelRoutingPolicy | null;
  readonly policy: ModelRoutingPolicy | null;
}) {
  const cells =
    draft.baseline && draft.policy ? modelCellChanges(draft.baseline, draft.policy) : [];
  return {
    editedCells: (driver: ModelDriver) => cells.filter((c) => c.driver === driver).length,
  };
}

/** The entries and settings `mine` changed in `base`, applied onto the newer stored `theirs`. */
function rebaseModelPolicy(
  base: ModelRoutingPolicy,
  mine: ModelRoutingPolicy,
  theirs: ModelRoutingPolicy,
) {
  let merged = theirs;
  for (const { driver, difficulty, stakes } of modelCellChanges(base, mine))
    merged = setModelCell(
      merged,
      driver,
      difficulty,
      stakes,
      modelCell(mine, driver, difficulty, stakes),
    );
  for (const key of modelSettingChanges(base, mine))
    merged =
      key === "codex" || key === "claudeAgent"
        ? setAllowedModels(merged, key, [
            // The newer list without the models the edit removed, then the ones it added.
            // Models the newer table or an edited entry approved stay approved.
            ...merged[key].allowedModels.filter(
              (m) => mine[key].allowedModels.includes(m) || !base[key].allowedModels.includes(m),
            ),
            ...mine[key].allowedModels.filter((m) => !base[key].allowedModels.includes(m)),
          ])
        : key === "ladder"
          ? { ...merged, ladder: modelLadder(mine) }
          : key === "fallback"
            ? { ...merged, fallback: modelFallback(mine) }
            : { ...merged, maxReassessments: mine.maxReassessments };
  return merged;
}

/**
 * Whether `theirs` changed an entry or setting that `mine` changed too, to something else.
 * The two model lists never collide: `rebaseModelPolicy` merges them.
 */
function modelEditsCollide(
  base: ModelRoutingPolicy,
  mine: ModelRoutingPolicy,
  theirs: ModelRoutingPolicy,
) {
  const [before, edited, newer] = [base, mine, theirs].map(modelSettings);
  return (
    modelCellChanges(base, mine).some(({ driver, difficulty, stakes }) => {
      const cell = modelCell(theirs, driver, difficulty, stakes);
      return (
        !sameModelCell(cell, modelCell(base, driver, difficulty, stakes)) &&
        !sameModelCell(cell, modelCell(mine, driver, difficulty, stakes))
      );
    }) ||
    modelSettingChanges(base, mine).some((key) => {
      if (key === "codex" || key === "claudeAgent") return false;
      const value = JSON.stringify(newer![key]);
      return value !== JSON.stringify(before![key]) && value !== JSON.stringify(edited![key]);
    })
  );
}

/** How the model table is compared, merged and checked when it saves itself. */
export const modelAutosaveRules = {
  dirty: (baseline, policy) =>
    modelCellChanges(baseline, policy).length > 0 ||
    modelSettingChanges(baseline, policy).length > 0,
  rebase: (base, mine, theirs) => ({
    policy: rebaseModelPolicy(base, mine, theirs),
    collides: modelEditsCollide(base, mine, theirs),
  }),
  invalid: (policy) => {
    const fallback = modelFallback(policy);
    return fallback && !(fallback.model && fallback.effort)
      ? "The fallback needs a model and an effort."
      : null;
  },
} satisfies Pick<AutosaveOptions<ModelRoutingPolicy>, "dirty" | "rebase" | "invalid">;
