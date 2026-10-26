import {
  describeSessionWorkers,
  type SessionWorkerSummary,
} from "@t3tools/client-runtime/state/session-organization";
import { Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

type Pane = "screen" | "sidebar" | undefined;

/** Rows below a group header hang off one guide line; workers of workers step in once more. */
export function sessionNestingClassName(depth: number, pane: Pane) {
  if (depth === 0) return undefined;
  return cn(
    "border-l pl-1.5",
    depth === 1 ? "ml-4" : "ml-7",
    pane === "sidebar" ? "border-drawer-border" : "border-border",
  );
}

const PART_TONE = {
  attention: {
    symbol: "exclamationmark.circle",
    tint: "accent-warning-foreground",
    text: "text-warning-foreground",
  },
  running: {
    symbol: "play",
    tint: "accent-adaptive-sky-600-400",
    text: "text-adaptive-sky-600-400",
  },
} as const satisfies Record<string, { symbol: AppSymbolName; tint: string; text: string }>;

/**
 * Disclosure row under a master: one line at any phone width. The attention
 * count spells itself out; the other counts are icon plus number, and the
 * button's name carries the full sentence for assistive tech.
 */
export function SessionGroupHeader(props: {
  readonly pane?: Pane;
  readonly title: string;
  readonly summary: SessionWorkerSummary;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const sidebarPane = props.pane === "sidebar";
  const description = describeSessionWorkers(props.summary);
  const mutedText = sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-muted";
  const mutedTint = sidebarPane ? "accent-drawer-foreground-muted" : "accent-foreground-muted";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.expanded ? "Collapse" : "Expand"} workers of ${props.title}: ${description.text}`}
      accessibilityState={{ expanded: props.expanded }}
      onPress={props.onToggle}
      className={cn("min-h-11 flex-row items-center gap-1.5", sidebarPane ? "px-3" : "px-5")}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <SymbolView
        name="chevron.right"
        size={11}
        tintColorClassName={mutedTint}
        type="monochrome"
        style={{ transform: [{ rotate: props.expanded ? "90deg" : "0deg" }] }}
      />
      <Text
        className={cn(
          "text-xs font-t3-medium",
          sidebarPane ? "text-drawer-foreground" : "text-foreground-secondary",
        )}
      >
        {description.total}
      </Text>
      <View className="flex-1" />
      <View className="shrink flex-row items-center gap-3">
        {description.parts.map((part) => {
          const tone =
            part.kind === "unavailable"
              ? ({ symbol: "wifi.slash", tint: mutedTint, text: mutedText } as const)
              : PART_TONE[part.kind];
          return (
            <View key={part.kind} className="shrink flex-row items-center gap-1">
              <SymbolView
                name={tone.symbol}
                size={12}
                tintColorClassName={tone.tint}
                type="monochrome"
              />
              <Text
                numberOfLines={1}
                className={cn(
                  "shrink text-xs tabular-nums",
                  part.kind === "attention" && "font-t3-medium",
                  tone.text,
                )}
              >
                {part.kind === "attention" ? `${part.count} ${part.phrase}` : part.count}
              </Text>
            </View>
          );
        })}
      </View>
    </Pressable>
  );
}

/** Completed workers stay one tap away at the top of an open group. */
export function SessionFinishedToggle(props: {
  readonly pane?: Pane;
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const sidebarPane = props.pane === "sidebar";
  return (
    <View className={sessionNestingClassName(1, props.pane)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.expanded ? "Hide" : "Show"} ${props.count} finished ${props.count === 1 ? "worker" : "workers"}`}
        accessibilityState={{ expanded: props.expanded }}
        onPress={props.onToggle}
        className={cn("min-h-11 flex-row items-center gap-1.5", sidebarPane ? "px-3" : "px-5")}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <SymbolView
          name="chevron.right"
          size={11}
          tintColorClassName={
            sidebarPane ? "accent-drawer-foreground-muted" : "accent-foreground-muted"
          }
          type="monochrome"
          style={{ transform: [{ rotate: props.expanded ? "90deg" : "0deg" }] }}
        />
        <Text
          className={cn(
            "text-xs tabular-nums",
            sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-muted",
          )}
        >
          Finished ({props.count})
        </Text>
      </Pressable>
    </View>
  );
}
