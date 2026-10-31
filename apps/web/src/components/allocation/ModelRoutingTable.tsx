import { memo, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { MODEL_SCORES, type ModelRoutingPolicy, type RoutingCell } from "@t3tools/contracts";
import {
  chooseModelForCell,
  effortDisplayName,
  modelCell,
  modelCellSummary,
  modelDisplayName,
  modelDriverLabel,
  modelProfileLabel,
  modelShortNames,
  sameModelCell,
  type ModelCatalog,
  type ModelDriver,
} from "@t3tools/client-runtime/state/model-routing";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

export interface ModelCellPosition {
  readonly difficulty: number;
  readonly stakes: number;
}
const field =
  "mt-1 block w-full min-w-0 max-w-full rounded border bg-background px-2 py-1 text-sm disabled:opacity-60";
// Theme tokens only, so every custom theme and light/dark mode keeps the table legible.
const tints = [
  "bg-info/8 text-info-foreground dark:bg-info/16",
  "bg-success/8 text-success-foreground dark:bg-success/16",
  "bg-warning/8 text-warning-foreground dark:bg-warning/16",
  "bg-primary/8 text-foreground dark:bg-primary/16",
];
const same = (a: ModelCellPosition | null, difficulty: number, stakes: number) =>
  a?.difficulty === difficulty && a.stakes === stakes;
const modelsUsed = (policy: ModelRoutingPolicy, driver: ModelDriver) =>
  [...new Set(policy[driver].cells.flatMap((row) => row.map((cell) => cell.model)))].sort();

/**
 * Difficulty runs across the top and stakes down the side, each as the exact 0-10 score.
 * Every cell is one button naming its model and reasoning; arrow keys move between cells.
 */
export const ModelRoutingMatrix = memo(function ModelRoutingMatrix(props: {
  driver: ModelDriver;
  policy: ModelRoutingPolicy;
  baseline: ModelRoutingPolicy | null;
  catalog: ModelCatalog;
  selected: ModelCellPosition | null;
  onSelect: (cell: ModelCellPosition) => void;
}) {
  const { driver, policy, baseline, catalog, selected, onSelect } = props;
  const table = useRef<HTMLTableElement>(null);
  const [focus, setFocus] = useState<ModelCellPosition | null>(null);
  const active = focus ?? selected ?? { difficulty: 0, stakes: 0 };
  const used = modelsUsed(policy, driver);
  const names = modelShortNames(used);
  const move = (event: KeyboardEvent) => {
    const origin = (event.target as HTMLElement).closest<HTMLElement>("[data-cell]")?.dataset.cell;
    const steps: Record<string, readonly [number, number]> = {
      ArrowRight: [1, 0],
      ArrowLeft: [-1, 0],
      ArrowDown: [0, 1],
      ArrowUp: [0, -1],
      Home: [-10, 0],
      End: [10, 0],
    };
    const step = steps[event.key];
    if (!origin || !step) return;
    event.preventDefault();
    const [difficulty, stakes] = origin.split("-").map(Number) as [number, number];
    const clamp = (n: number) => Math.min(10, Math.max(0, n));
    table.current
      ?.querySelector<HTMLElement>(
        `[data-cell="${clamp(difficulty + step[0])}-${clamp(stakes + step[1])}"]`,
      )
      ?.focus();
  };
  return (
    <div className="max-h-[75vh] min-w-0 max-w-full overflow-auto rounded-md border">
      <table
        ref={table}
        aria-label={`${modelDriverLabel(driver)} model table`}
        className="w-full min-w-[44rem] border-separate border-spacing-px text-xs"
        onKeyDown={move}
      >
        <thead>
          <tr>
            <th scope="col" className="sticky top-0 left-0 z-20 h-6 bg-background">
              <span className="sr-only">Stakes by difficulty</span>
            </th>
            <th
              scope="colgroup"
              colSpan={MODEL_SCORES.length}
              className="sticky top-0 z-10 h-6 bg-background px-1 text-left font-medium text-muted-foreground"
            >
              <span className="sticky left-14 inline-block">Difficulty →</span>
            </th>
          </tr>
          <tr>
            <th
              scope="col"
              className="sticky top-6 left-0 z-20 h-6 w-14 min-w-14 bg-background px-1 text-left font-medium text-muted-foreground"
            >
              Stakes ↓
            </th>
            {MODEL_SCORES.map((difficulty) => (
              <th
                key={difficulty}
                scope="col"
                className="sticky top-6 z-10 h-6 bg-background px-1 font-medium"
              >
                <span className="sr-only">Difficulty </span>
                {difficulty}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {MODEL_SCORES.map((stakes) => (
            <tr key={stakes}>
              <th
                scope="row"
                className="sticky left-0 z-10 bg-background px-1 py-1 text-center font-medium"
              >
                <span className="sr-only">Stakes </span>
                {stakes}
              </th>
              {MODEL_SCORES.map((difficulty) => {
                const cell = modelCell(policy, driver, difficulty, stakes);
                const was = baseline ? modelCell(baseline, driver, difficulty, stakes) : cell;
                const edited = !sameModelCell(was, cell);
                const offered = !catalog.known || catalog.supports(cell);
                const chosen = same(selected, difficulty, stakes);
                return (
                  <td key={difficulty} className="p-0">
                    <button
                      type="button"
                      data-cell={`${difficulty}-${stakes}`}
                      tabIndex={same(active, difficulty, stakes) ? 0 : -1}
                      aria-pressed={chosen}
                      aria-label={`Difficulty ${difficulty}, stakes ${stakes}: ${modelProfileLabel(cell)}${
                        cell.alternatives?.length ? ", with an alternative" : ""
                      }${edited ? ", edited" : ""}${offered ? "" : ", not offered by connected accounts"}`}
                      className={cn(
                        "flex min-h-9 w-full cursor-pointer flex-col items-center justify-center rounded px-0.5 py-0.5 leading-tight outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        tints[used.indexOf(cell.model) % tints.length],
                        chosen && "ring-2 ring-primary",
                      )}
                      onClick={() => onSelect({ difficulty, stakes })}
                      onFocus={() => setFocus({ difficulty, stakes })}
                    >
                      <span className="block max-w-full truncate font-medium">
                        {names.get(cell.model)}
                      </span>
                      <span className="block max-w-full truncate">
                        {effortDisplayName(cell.effort)}
                        <span aria-hidden>
                          {cell.alternatives?.length ? " ↳" : ""}
                          {edited ? " •" : ""}
                          {offered ? "" : " !"}
                        </span>
                      </span>
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

export function ModelRoutingLegend(props: { driver: ModelDriver; policy: ModelRoutingPolicy }) {
  const used = modelsUsed(props.policy, props.driver);
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      {used.map((model, i) => (
        <span key={model} className={cn("rounded px-1.5 py-0.5", tints[i % tints.length])}>
          {modelDisplayName(model)} ({model})
        </span>
      ))}
      <span>• edited · ! not offered by a connected account · ↳ has an alternative</span>
    </p>
  );
}

/** The one editor for the selected cell: model, reasoning and an optional alternative. */
export function ModelCellEditor(props: {
  driver: ModelDriver;
  position: ModelCellPosition | null;
  cell: RoutingCell | null;
  saved: RoutingCell | null;
  catalog: ModelCatalog;
  online: boolean;
  pendingModel: string | null;
  onPendingModel: (model: string | null) => void;
  onChange: (cell: RoutingCell) => void;
}) {
  const { driver, position, cell, saved, catalog, online, pendingModel, onPendingModel } = props;
  const root = useRef<HTMLDivElement>(null);
  // On a phone the table can be taller than the screen: keep the editor in view after a pick.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the editor DOM node into view after selection.
  useEffect(() => {
    if (position) root.current?.scrollIntoView?.({ block: "nearest" });
  }, [position]);
  if (!position || !cell)
    return (
      <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
        Select a cell to change its model or reasoning.
      </p>
    );
  const model = pendingModel ?? cell.model;
  const efforts = catalog.efforts(model);
  const pairs = catalog.models.flatMap((m) =>
    catalog.efforts(m).map((effort) => ({ model: m, effort })),
  );
  const fallback = cell.alternatives?.[0];
  const edited = saved !== null && !sameModelCell(saved, cell);
  const pairKey = (p: { model: string; effort: string }) => `${p.model}\n${p.effort}`;
  const offeredFallbacks = pairs.filter((p) => p.model !== cell.model || p.effort !== cell.effort);
  return (
    <div ref={root} className="grid min-w-0 gap-3 rounded-md border p-3 sm:grid-cols-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 sm:col-span-3">
        <h2 className="text-sm font-medium" aria-live="polite">
          {modelDriverLabel(driver)} · difficulty {position.difficulty}, stakes {position.stakes}:{" "}
          {modelCellSummary(cell)}
        </h2>
        {edited && saved && (
          <Button size="xs" variant="outline" onClick={() => props.onChange(saved)}>
            Undo this cell
          </Button>
        )}
      </div>
      <label className="min-w-0 text-sm">
        Model
        <select
          className={field}
          value={model}
          disabled={!catalog.known}
          onChange={(e) => {
            const result = chooseModelForCell(cell, e.target.value, catalog);
            if ("cell" in result) {
              onPendingModel(null);
              props.onChange(result.cell);
            } else onPendingModel(result.pendingModel);
          }}
        >
          {(catalog.models.includes(cell.model)
            ? catalog.models
            : [cell.model, ...catalog.models]
          ).map((m) => (
            <option key={m} value={m}>
              {modelDisplayName(m)} ({m}){catalog.models.includes(m) ? "" : ": not offered"}
            </option>
          ))}
        </select>
      </label>
      <label className="min-w-0 text-sm">
        Reasoning
        <select
          className={field}
          value={pendingModel ? "" : cell.effort}
          disabled={!catalog.known}
          onChange={(e) => {
            if (!e.target.value) return;
            onPendingModel(null);
            props.onChange({ ...cell, model, effort: e.target.value });
          }}
        >
          {pendingModel && (
            <option value="" disabled>
              Choose reasoning
            </option>
          )}
          {(pendingModel || efforts.includes(cell.effort)
            ? efforts
            : [cell.effort, ...efforts]
          ).map((effort) => (
            <option key={effort} value={effort}>
              {effort}
              {efforts.includes(effort) ? "" : ": not offered"}
            </option>
          ))}
        </select>
      </label>
      <label className="min-w-0 text-sm">
        If unavailable
        <select
          className={field}
          value={fallback ? pairKey(fallback) : ""}
          disabled={!catalog.known || pendingModel !== null}
          onChange={(e) => {
            const choice = pairs.find((p) => pairKey(p) === e.target.value);
            const { alternatives: _previous, ...primary } = cell;
            props.onChange(choice ? { ...primary, alternatives: [choice] } : primary);
          }}
        >
          <option value="">No alternative</option>
          {fallback && !offeredFallbacks.some((p) => pairKey(p) === pairKey(fallback)) && (
            <option value={pairKey(fallback)}>{modelProfileLabel(fallback)}: not offered</option>
          )}
          {offeredFallbacks.map((p) => (
            <option key={pairKey(p)} value={pairKey(p)}>
              {modelDisplayName(p.model)} · {p.effort}
            </option>
          ))}
        </select>
      </label>
      {pendingModel && (
        <p className="text-sm text-warning-foreground sm:col-span-3">
          {modelDisplayName(pendingModel)} does not offer {cell.effort}. Choose its reasoning to
          apply the change.
        </p>
      )}
      {(cell.alternatives?.length ?? 0) > 1 && (
        <p className="text-sm text-muted-foreground sm:col-span-3">
          Configured order: {cell.alternatives!.map(modelProfileLabel).join(" → ")}. Choosing an
          alternative here replaces this list.
        </p>
      )}
      {!catalog.known ? (
        <p className="text-sm text-muted-foreground sm:col-span-3">
          No connected {modelDriverLabel(driver)} account has advertised models yet. Reconnect to
          change this cell.
        </p>
      ) : (
        !online && (
          <p className="text-sm text-muted-foreground sm:col-span-3">
            Offline: choices come from the last known model list. Reconnect to save.
          </p>
        )
      )}
    </div>
  );
}
