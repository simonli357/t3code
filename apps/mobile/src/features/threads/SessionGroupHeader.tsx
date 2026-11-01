import { Pressable, View } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { useSessionGroups } from "./useSessionGroups";
import type { ThreadListV2SessionGroupItem } from "./threadListV2";

export function SessionGroupHeader({ item }: { item: ThreadListV2SessionGroupItem }) {
  const groups = useSessionGroups();
  return (
    <View className="px-3 py-1">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: item.expanded }}
        accessibilityLabel={`${item.expanded ? "Collapse" : "Expand"} ${item.title}: ${item.summary}`}
        onPress={() => groups.toggle(item.groupKey)}
      >
        <AppText className="text-xs text-foreground-muted">
          {item.expanded ? "▾" : "▸"} {item.title} · {item.summary}
        </AppText>
      </Pressable>
      {item.expanded && item.finished > 0 && (
        <Pressable accessibilityRole="button" onPress={() => groups.toggleFinished(item.groupKey)}>
          <AppText className="text-xs text-foreground-muted">
            {item.finishedExpanded ? "Hide" : "Show"} {item.finished} finished workers
          </AppText>
        </Pressable>
      )}
    </View>
  );
}
