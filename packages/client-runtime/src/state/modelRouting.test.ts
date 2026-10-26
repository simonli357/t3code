import { expect, it } from "vite-plus/test";
import {
  defaultModelRoutingPolicy,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelRoutingPolicy,
  type ModelRoutingSnapshot,
} from "@t3tools/contracts";
import {
  adoptModelPolicy,
  acknowledgeModelSave,
  chooseModelForCell,
  discardModelDraft,
  editModelDraft,
  emptyModelDraft,
  modelCatalog,
  modelCell,
  modelCellChanges,
  modelDisplayName,
  modelDraftChanges,
  modelDraftDirty,
  modelDraftStale,
  modelEditorUrl,
  modelShortNames,
  rebaseModelDraft,
  receiveSavedModelPolicy,
  resetModelTable,
  setModelCell,
  summarizeModelDraft,
} from "./modelRouting.ts";

it("acknowledges only submitted cells and settings, retaining edits made during a save", () => {
  const submitted = setModelCell(defaultModelRoutingPolicy, "codex", 5, 2, {
    model: "gpt-6-astra",
    effort: "high",
  });
  const current = editModelDraft(adoptModelPolicy(submitted), (p) => ({
    ...setModelCell(p, "claudeAgent", 1, 2, { model: "claude-opus-5-5", effort: "high" }),
    maxReassessments: 1,
  }));
  const saved = { ...submitted, version: 4 };
  const draft = acknowledgeModelSave(current, submitted, saved);
  expect(draft.baseline).toEqual(saved);
  expect(draft.policy?.codex).toEqual(saved.codex);
  expect(draft.policy?.claudeAgent.cells[1]![2]).toEqual({
    model: "claude-opus-5-5",
    effort: "high",
  });
  expect(draft.policy?.maxReassessments).toBe(1);
  expect(modelDraftStale(draft)).toBe(false);
  expect(modelDraftChanges(draft)).toEqual({
    cells: [{ driver: "claudeAgent", difficulty: 1, stakes: 2 }],
    settings: true,
  });
});
it("opens the selected remote environment editor without retaining pairing tokens or fragments", () => {
  expect(modelEditorUrl(null, "relay")).toBeNull();
  expect(modelEditorUrl("user@ssh-host", "ssh")).toBeNull();
  expect(modelEditorUrl("wss://myalien.example:444/ws?token=private#old", "myalien")).toBe(
    "https://myalien.example:444/settings/model-selection?machine=myalien",
  );
});

it("names models briefly, keeping the version only where two models would read the same", () => {
  expect(
    [
      "gpt-6.1-sol",
      "gpt-6-astra",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "gpt-5.4",
      "o3-mini",
    ].map(modelDisplayName),
  ).toEqual(["Sol 6.1", "Astra 6", "Sonnet 5.5", "Opus 5.5", "GPT 5.4", "O3 Mini"]);
  expect([...modelShortNames(["gpt-6.1-sol", "gpt-6-astra"]).values()]).toEqual(["Sol", "Astra"]);
  expect([
    ...modelShortNames(["claude-sonnet-5-5", "claude-sonnet-4-5", "claude-opus-5-5"]).values(),
  ]).toEqual(["Sonnet 5.5", "Sonnet 4.5", "Opus"]);
});

const account = (
  environmentId: string,
  driver: string,
  models: Record<string, readonly string[]>,
): ModelRoutingSnapshot["inventories"][number]["accounts"][number] => ({
  environmentId,
  instanceId: ProviderInstanceId.make(`${environmentId}-${driver}`),
  driver: ProviderDriverKind.make(driver),
  label: driver,
  accountKey: driver,
  available: true,
  unavailableReason: null,
  limitedUntil: null,
  shortWindow: "unknown",
  windows: [],
  resetCredits: null,
  profileSamples: 0,
  profileUncertainty: 1,
  models: Object.entries(models).map(([slug, efforts]) => ({
    slug,
    capabilities: {
      optionDescriptors: [
        {
          id: driver === "codex" ? "reasoningEffort" : "effort",
          type: "select" as const,
          label: "Effort",
          options: efforts.map((id) => ({ id, label: id })),
        },
      ],
    },
  })),
});
const inventories = [
  {
    environmentId: "host",
    observedAt: "2026-10-24T12:00:00.000Z",
    complete: true,
    notices: [],
    demand: [],
    accounts: [
      account("host", "codex", {
        "gpt-6.1-sol": ["medium", "high", "max"],
        "gpt-6-astra": ["medium", "high", "xhigh"],
        "gpt-6-luna": ["medium"],
      }),
      account("other", "codex", { "gpt-6.1-sol": ["medium", "ultra"] }),
    ],
  },
];

it("lists only what this environment's accounts advertise for automatic selection", () => {
  const catalog = modelCatalog(inventories, "host", "codex");
  expect(catalog.known).toBe(true);
  expect(catalog.models).toEqual(["gpt-6-astra", "gpt-6.1-sol"]);
  expect(catalog.efforts("gpt-6-astra")).toEqual(["medium", "high", "xhigh"]);
  expect(catalog.efforts("gpt-6.1-sol")).toEqual(["medium", "high", "max"]);
  expect(catalog.supports({ model: "gpt-6.1-sol", effort: "ultra" })).toBe(false);
  expect(catalog.supports({ model: "gpt-6-astra", effort: "xhigh" })).toBe(true);
  expect(modelCatalog(inventories, "host", "claudeAgent").known).toBe(false);
});

it("edits exactly one entry, approves its model, and never changes the other provider", () => {
  const edited = setModelCell(defaultModelRoutingPolicy, "codex", 7, 8, {
    model: "gpt-6-sol-pro",
    effort: "max",
    alternatives: [
      { model: "gpt-6-sol-pro", effort: "max" },
      { model: "gpt-6-astra", effort: "high" },
    ],
  });
  expect(modelCellChanges(defaultModelRoutingPolicy, edited)).toEqual([
    { driver: "codex", difficulty: 7, stakes: 8 },
  ]);
  expect(modelCell(edited, "codex", 7, 8)).toEqual({
    model: "gpt-6-sol-pro",
    effort: "max",
    alternatives: [{ model: "gpt-6-astra", effort: "high" }],
  });
  expect(edited.codex.allowedModels).toEqual([
    ...defaultModelRoutingPolicy.codex.allowedModels,
    "gpt-6-sol-pro",
  ]);
  expect(edited.claudeAgent).toBe(defaultModelRoutingPolicy.claudeAgent);
  expect(defaultModelRoutingPolicy.codex.cells[7]![8]).not.toEqual(
    modelCell(edited, "codex", 7, 8),
  );
});

it("keeps reasoning when the new model offers it and otherwise asks, never weakening silently", () => {
  const catalog = modelCatalog(inventories, "host", "codex");
  const cell = { model: "gpt-6.1-sol", effort: "max" };
  expect(chooseModelForCell({ ...cell, effort: "high" }, "gpt-6-astra", catalog)).toEqual({
    cell: { model: "gpt-6-astra", effort: "high" },
  });
  expect(chooseModelForCell(cell, "gpt-6-astra", catalog)).toEqual({
    pendingModel: "gpt-6-astra",
    efforts: ["medium", "high", "xhigh"],
  });
});

const edit = (policy: ModelRoutingPolicy, difficulty: number, stakes: number, effort: string) =>
  setModelCell(policy, "claudeAgent", difficulty, stakes, {
    ...modelCell(policy, "claudeAgent", difficulty, stakes),
    effort,
  });

it("follows newer saved tables until edits exist, then flags and rebases them", () => {
  const v3 = { ...defaultModelRoutingPolicy, version: 3 };
  let draft = receiveSavedModelPolicy(emptyModelDraft, v3);
  expect(modelDraftDirty(draft)).toBe(false);
  draft = receiveSavedModelPolicy(draft, { ...v3, version: 4 });
  expect(draft.baseline?.version).toBe(4);

  draft = editModelDraft(draft, (p) => edit(p, 7, 8, "xhigh"));
  draft = editModelDraft(draft, (p) => ({ ...p, maxReassessments: 3 }));
  expect(modelDraftChanges(draft)).toEqual({
    cells: [{ driver: "claudeAgent", difficulty: 7, stakes: 8 }],
    settings: true,
  });
  expect(modelDraftStale(draft)).toBe(false);
  const summary = summarizeModelDraft(draft);
  expect([summary.dirty, summary.stale, summary.count]).toEqual([true, false, 2]);
  expect([summary.editedCells("claudeAgent"), summary.editedCells("codex")]).toEqual([1, 0]);

  // Another editor saved version 5 changing a different entry and the same one differently.
  const other = setModelCell(edit({ ...v3, version: 5 }, 2, 2, "max"), "claudeAgent", 7, 8, {
    model: "claude-opus-5-5",
    effort: "medium",
  });
  draft = receiveSavedModelPolicy(draft, other);
  expect(draft.policy).not.toBe(other);
  expect(draft.baseline?.version).toBe(4);
  expect(modelDraftStale(draft)).toBe(true);

  const rebased = rebaseModelDraft(draft);
  expect(rebased.baseline).toBe(other);
  expect(rebased.policy?.version).toBe(5);
  expect(rebased.policy?.maxReassessments).toBe(3);
  expect(modelCell(rebased.policy!, "claudeAgent", 2, 2).effort).toBe("max");
  expect(modelCell(rebased.policy!, "claudeAgent", 7, 8).effort).toBe("xhigh");
  expect(modelDraftChanges(rebased).cells).toEqual([
    { driver: "claudeAgent", difficulty: 7, stakes: 8 },
  ]);
  expect(modelDraftStale(rebased)).toBe(false);

  expect(discardModelDraft(draft)).toEqual(adoptModelPolicy(other));
});

it("treats a different table at the same version as newer, since it came from another coordinator", () => {
  const v3 = { ...defaultModelRoutingPolicy, version: 3 };
  let draft = editModelDraft(receiveSavedModelPolicy(emptyModelDraft, v3), (p) =>
    edit(p, 7, 8, "xhigh"),
  );
  draft = receiveSavedModelPolicy(draft, { ...v3 });
  expect(modelDraftStale(draft)).toBe(false);
  draft = receiveSavedModelPolicy(draft, edit(v3, 2, 2, "max"));
  expect(modelDraftStale(draft)).toBe(true);
  const rebased = rebaseModelDraft(draft);
  expect(modelDraftStale(rebased)).toBe(false);
  expect(modelCell(rebased.policy!, "claudeAgent", 2, 2).effort).toBe("max");
  expect(modelDraftChanges(rebased).cells).toEqual([
    { driver: "claudeAgent", difficulty: 7, stakes: 8 },
  ]);
});

it("resets one provider table to the defaults as a draft edit only", () => {
  const saved = edit(edit(defaultModelRoutingPolicy, 1, 1, "xhigh"), 9, 9, "medium");
  const codexEdited = setModelCell(saved, "codex", 0, 0, { model: "gpt-6-astra", effort: "high" });
  const reset = resetModelTable(codexEdited, "codex");
  expect(reset.codex).toBe(defaultModelRoutingPolicy.codex);
  expect(reset.claudeAgent).toBe(codexEdited.claudeAgent);
  const draft = editModelDraft(adoptModelPolicy(codexEdited), (p) => resetModelTable(p, "codex"));
  expect(modelDraftDirty(draft)).toBe(true);
  expect(modelDraftChanges(draft).cells.every((c) => c.driver === "codex")).toBe(true);
});
