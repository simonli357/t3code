import { expect, it } from "vite-plus/test";
import {
  defaultModelFallback,
  defaultModelLadder,
  defaultModelRoutingPolicy,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelRoutingPolicy,
  type ModelRoutingSnapshot,
} from "@t3tools/contracts";
import {
  chooseModelForCell,
  modelAutosaveRules,
  modelCatalog,
  modelCell,
  modelCellChanges,
  modelDisplayName,
  modelEditorUrl,
  modelShortNames,
  resetModelTable,
  setAllowedModels,
  setModelCell,
  summarizeModelDraft,
} from "./modelRouting.ts";
const { dirty, rebase } = modelAutosaveRules;

it("keeps edits made while a save was on its way, on top of what the save stored", () => {
  const submitted = setModelCell(defaultModelRoutingPolicy, "codex", 5, 2, {
    model: "gpt-6-astra",
    effort: "high",
  });
  const current = {
    ...setModelCell(submitted, "claudeAgent", 1, 2, { model: "claude-opus-5-5", effort: "high" }),
    fallback: null,
  };
  const saved = { ...submitted, version: 4 };
  const { policy, collides } = rebase(submitted, current, saved);
  expect(collides).toBe(false);
  expect(policy).toMatchObject({ version: 4, fallback: null });
  expect(policy.codex).toEqual(saved.codex);
  expect(modelCellChanges(saved, policy)).toEqual([
    { driver: "claudeAgent", difficulty: 1, stakes: 2 },
  ]);
  expect(dirty(saved, policy)).toBe(true);
  expect(dirty(saved, saved)).toBe(false);
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

it("lists every model this environment's accounts advertise", () => {
  const catalog = modelCatalog(inventories, "host", "codex");
  expect(catalog.known).toBe(true);
  expect(catalog.models).toEqual(["gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"]);
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

it("applies edits onto a newer stored table, and says when it changed the same entry or setting", () => {
  const v4 = { ...defaultModelRoutingPolicy, version: 4 };
  const mine = { ...edit(v4, 7, 8, "xhigh"), fallback: null };
  expect(dirty(v4, mine)).toBe(true);
  const counted = summarizeModelDraft({ baseline: v4, policy: mine });
  expect([counted.editedCells("claudeAgent"), counted.editedCells("codex")]).toEqual([1, 0]);

  // Stored elsewhere as version 5: a different entry changed.
  const apart = edit({ ...v4, version: 5 }, 2, 2, "max");
  const merged = rebase(v4, mine, apart);
  expect(merged.collides).toBe(false);
  expect(merged.policy).toMatchObject({ version: 5, fallback: null });
  expect(modelCell(merged.policy, "claudeAgent", 2, 2).effort).toBe("max");
  expect(modelCell(merged.policy, "claudeAgent", 7, 8).effort).toBe("xhigh");
  expect(modelCellChanges(apart, merged.policy)).toEqual([
    { driver: "claudeAgent", difficulty: 7, stakes: 8 },
  ]);

  // The same entry changed to something else: the edit still wins, and the caller asks.
  const same = setModelCell(apart, "claudeAgent", 7, 8, {
    model: "claude-opus-5-5",
    effort: "medium",
  });
  expect(rebase(v4, mine, same).collides).toBe(true);
  expect(modelCell(rebase(v4, mine, same).policy, "claudeAgent", 7, 8).effort).toBe("xhigh");
  // Changed elsewhere to the very same value, or a setting changed there too.
  expect(rebase(v4, mine, edit(apart, 7, 8, "xhigh")).collides).toBe(false);
  expect(rebase(v4, mine, { ...apart, fallback: null }).collides).toBe(false);
  expect(
    rebase(v4, mine, { ...apart, fallback: { ...defaultModelFallback, model: "other" } }).collides,
  ).toBe(true);
});

it("resets one provider table to the built-in one", () => {
  const saved = edit(edit(defaultModelRoutingPolicy, 1, 1, "xhigh"), 9, 9, "medium");
  const codexEdited = setModelCell(saved, "codex", 0, 0, { model: "gpt-6-astra", effort: "high" });
  const reset = resetModelTable(codexEdited, "codex");
  expect(reset.codex).toBe(defaultModelRoutingPolicy.codex);
  expect(reset.claudeAgent).toBe(codexEdited.claudeAgent);
  expect(dirty(codexEdited, reset)).toBe(true);
  expect(modelCellChanges(codexEdited, reset).every((c) => c.driver === "codex")).toBe(true);
});

it("counts ladder, fallback and model list edits as changes and merges model lists both ways", () => {
  const saved = { ...defaultModelRoutingPolicy, version: 3 };
  const [first, ...rest] = saved.claudeAgent.allowedModels;
  const mine = setAllowedModels(
    { ...saved, fallback: null, ladder: defaultModelLadder.slice(1) },
    "claudeAgent",
    [...rest, "typed-model"],
  );
  expect(dirty(saved, mine)).toBe(true);
  // An explicit default is the same as an absent one.
  expect(
    dirty(saved, { ...saved, ladder: defaultModelLadder, fallback: defaultModelFallback }),
  ).toBe(false);
  // Stored elsewhere meanwhile: one more model on the same list.
  const newer = setAllowedModels({ ...saved, version: 4 }, "claudeAgent", [
    ...saved.claudeAgent.allowedModels,
    "theirs-model",
  ]);
  const { policy, collides } = rebase(saved, mine, newer);
  expect(collides).toBe(false);
  expect(policy).toMatchObject({ version: 4, fallback: null });
  expect(policy.ladder).toEqual(defaultModelLadder.slice(1));
  // Their addition stays, mine is added, and the one I removed is gone.
  expect(policy.claudeAgent.allowedModels).toEqual([...rest, "theirs-model", "typed-model"]);
  expect(policy.claudeAgent.allowedModels).not.toContain(first);
  expect(policy.codex).toEqual(saved.codex);
});
