import { Pressable, ScrollView, View } from "react-native";
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
import { AppText as Text } from "../../components/AppText";

export interface ModelCellPosition {
  readonly difficulty: number;
  readonly stakes: number;
}
// Fills come from adaptive tokens; the model name in each cell carries the meaning.
const tints = ["bg-subtle", "bg-secondary", "bg-subtle-strong", "bg-card-alt"];
const modelsUsed = (policy: ModelRoutingPolicy, driver: ModelDriver) =>
  [...new Set(policy[driver].cells.flatMap((row) => row.map((cell) => cell.model)))].sort();

export function Action(props: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" disabled={props.disabled} onPress={props.onPress}>
      <Text className={props.disabled ? "text-foreground-muted" : "text-primary"}>
        {props.label}
      </Text>
    </Pressable>
  );
}
function Chip(props: { label: string; active: boolean; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.active, disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={`rounded-full border px-3 py-1 ${props.active ? "border-primary bg-primary" : "border-border"}`}
    >
      <Text className={props.active ? "text-primary-foreground" : "text-foreground"}>
        {props.label}
      </Text>
    </Pressable>
  );
}

/**
 * Stakes stay pinned at the left while the 0-10 difficulty columns scroll sideways, so every
 * cell keeps both of its scores visible.
 */
export function ModelRoutingMatrix(props: {
  driver: ModelDriver;
  policy: ModelRoutingPolicy;
  baseline: ModelRoutingPolicy | null;
  catalog: ModelCatalog;
  selected: ModelCellPosition | null;
  onSelect: (cell: ModelCellPosition) => void;
}) {
  const { driver, policy, baseline, catalog, selected } = props;
  const used = modelsUsed(policy, driver);
  const names = modelShortNames(used);
  return (
    <View className="flex-row">
      <View>
        <View className="h-10 w-12 justify-center">
          <Text className="text-xs text-foreground-muted">Stakes ↓</Text>
          <Text className="text-xs text-foreground-muted">Diff. →</Text>
        </View>
        {MODEL_SCORES.map((stakes) => (
          <View key={stakes} className="h-11 w-12 items-center justify-center">
            <Text className="font-t3-medium">{stakes}</Text>
          </View>
        ))}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View>
          <View className="h-10 flex-row">
            {MODEL_SCORES.map((difficulty) => (
              <View key={difficulty} className="w-20 items-center justify-center">
                <Text className="font-t3-medium">{difficulty}</Text>
              </View>
            ))}
          </View>
          {MODEL_SCORES.map((stakes) => (
            <View key={stakes} className="h-11 flex-row">
              {MODEL_SCORES.map((difficulty) => {
                const cell = modelCell(policy, driver, difficulty, stakes);
                const edited = baseline
                  ? !sameModelCell(modelCell(baseline, driver, difficulty, stakes), cell)
                  : false;
                const offered = !catalog.known || catalog.supports(cell);
                const chosen = selected?.difficulty === difficulty && selected.stakes === stakes;
                return (
                  <Pressable
                    key={difficulty}
                    accessibilityRole="button"
                    accessibilityLabel={`Difficulty ${difficulty}, stakes ${stakes}: ${modelProfileLabel(cell)}${
                      cell.alternatives?.length ? ", with an alternative" : ""
                    }${edited ? ", edited" : ""}${offered ? "" : ", not offered by connected accounts"}`}
                    accessibilityState={{ selected: chosen }}
                    onPress={() => props.onSelect({ difficulty, stakes })}
                    className={`w-20 items-center justify-center rounded border ${
                      chosen ? "border-primary" : "border-transparent"
                    } ${tints[used.indexOf(cell.model) % tints.length]}`}
                  >
                    <Text numberOfLines={1} className="text-xs font-t3-medium">
                      {names.get(cell.model)}
                    </Text>
                    <Text numberOfLines={1} className="text-xs text-foreground-muted">
                      {effortDisplayName(cell.effort)}
                      {cell.alternatives?.length ? " ↳" : ""}
                      {edited ? " •" : ""}
                      {offered ? "" : " !"}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

export function ModelRoutingLegend(props: { driver: ModelDriver; policy: ModelRoutingPolicy }) {
  return (
    <Text className="text-xs text-foreground-muted">
      {modelsUsed(props.policy, props.driver)
        .map((m) => `${modelDisplayName(m)} (${m})`)
        .join(" · ")}{" "}
      · • edited · ! not offered by a connected account · ↳ has an alternative
    </Text>
  );
}

/** The one editor for the selected cell: model, reasoning and an optional alternative. */
export function ModelCellEditor(props: {
  driver: ModelDriver;
  position: ModelCellPosition | null;
  cell: RoutingCell | null;
  saved: RoutingCell | null;
  catalog: ModelCatalog;
  alternativeOpen: boolean;
  onAlternativeOpen: (open: boolean) => void;
  pendingModel: string | null;
  onPendingModel: (model: string | null) => void;
  onChange: (cell: RoutingCell) => void;
}) {
  const { driver, position, cell, saved, catalog, pendingModel } = props;
  if (!position || !cell)
    return (
      <Text className="text-foreground-muted">Select a cell to change its model or reasoning.</Text>
    );
  const model = pendingModel ?? cell.model;
  const efforts = catalog.efforts(model);
  const pairs = catalog.models
    .flatMap((m) => catalog.efforts(m).map((effort) => ({ model: m, effort })))
    .filter((p) => p.model !== cell.model || p.effort !== cell.effort);
  const fallback = cell.alternatives?.[0];
  const edited = saved !== null && !sameModelCell(saved, cell);
  return (
    <View className="gap-3 rounded border border-border p-3">
      <Text className="font-t3-medium">
        {modelDriverLabel(driver)} · difficulty {position.difficulty}, stakes {position.stakes}:{" "}
        {modelCellSummary(cell)}
      </Text>
      <Text className="text-foreground-muted">Model</Text>
      <View className="flex-row flex-wrap gap-2">
        {(catalog.models.includes(cell.model)
          ? catalog.models
          : [cell.model, ...catalog.models]
        ).map((m) => (
          <Chip
            key={m}
            label={`${modelDisplayName(m)}${catalog.models.includes(m) ? "" : " (not offered)"}`}
            active={model === m}
            disabled={!catalog.known}
            onPress={() => {
              const result = chooseModelForCell(cell, m, catalog);
              if ("cell" in result) {
                props.onPendingModel(null);
                props.onChange(result.cell);
              } else props.onPendingModel(result.pendingModel);
            }}
          />
        ))}
      </View>
      <Text className="text-foreground-muted">Reasoning</Text>
      <View className="flex-row flex-wrap gap-2">
        {(pendingModel || efforts.includes(cell.effort) ? efforts : [cell.effort, ...efforts]).map(
          (effort) => (
            <Chip
              key={effort}
              label={`${effort}${efforts.includes(effort) ? "" : " (not offered)"}`}
              active={!pendingModel && cell.effort === effort}
              disabled={!catalog.known}
              onPress={() => {
                props.onPendingModel(null);
                props.onChange({ ...cell, model, effort });
              }}
            />
          ),
        )}
      </View>
      {pendingModel && (
        <Text className="text-warning-foreground">
          {modelDisplayName(pendingModel)} does not offer {cell.effort}. Choose its reasoning to
          apply the change.
        </Text>
      )}
      <Action
        label={props.alternativeOpen ? "Hide alternative" : "Alternative if unavailable"}
        onPress={() => props.onAlternativeOpen(!props.alternativeOpen)}
      />
      {props.alternativeOpen && (
        <View className="flex-row flex-wrap gap-2">
          <Chip
            label="No alternative"
            active={!fallback}
            onPress={() => {
              const { alternatives: _previous, ...primary } = cell;
              props.onChange(primary);
            }}
          />
          {pairs.map((p) => (
            <Chip
              key={`${p.model}/${p.effort}`}
              label={`${modelDisplayName(p.model)} · ${p.effort}`}
              active={fallback?.model === p.model && fallback.effort === p.effort}
              disabled={pendingModel !== null}
              onPress={() => props.onChange({ ...cell, alternatives: [p] })}
            />
          ))}
        </View>
      )}
      {(cell.alternatives?.length ?? 0) > 1 && (
        <Text className="text-foreground-muted">
          Configured order: {cell.alternatives!.map(modelProfileLabel).join(" → ")}. Choosing an
          alternative replaces this list.
        </Text>
      )}
      {edited && saved && <Action label="Undo this cell" onPress={() => props.onChange(saved)} />}
      {!catalog.known && (
        <Text className="text-foreground-muted">
          No connected {modelDriverLabel(driver)} account has advertised models yet. Reconnect to
          change this cell.
        </Text>
      )}
    </View>
  );
}
