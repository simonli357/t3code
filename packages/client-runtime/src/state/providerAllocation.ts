import {
  WS_METHODS,
  type AllocationPolicy,
  type AllocationSnapshot,
  type AllocationRequest,
  type AllocationDecision,
} from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createAllocationCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    execute: createEnvironmentRpcCommand(runtime, {
      label: "provider-allocation",
      tag: WS_METHODS.providerAllocation,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "provider-allocation:start",
      tag: WS_METHODS.providerAllocationStart,
    }),
  };
}

/** A preview is tied to the exact editor content and request, not just its version. */
export function allocationPreviewKey(policy: AllocationPolicy, request: AllocationRequest): string {
  return JSON.stringify({ policy, request });
}

export function allocationChartPoints(
  snapshot: AllocationSnapshot,
  accountKey: string,
  windowId: string,
) {
  const points = [...snapshot.history]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .flatMap((decision) => {
      const candidate = decision.candidates.find(
        (c) => c.accountKey === accountKey && c.windows.some((w) => w.id === windowId),
      );
      const window = candidate?.windows.find((w) => w.id === windowId);
      return window
        ? [{ at: decision.at, actual: window.actualPoints, target: window.targetPoints }]
        : [];
    });
  const first = Date.parse(points[0]?.at ?? "");
  const last = Date.parse(points.at(-1)?.at ?? "");
  return points.map((p) => ({
    ...p,
    xPercent: last > first ? ((Date.parse(p.at) - first) * 100) / (last - first) : 0,
  }));
}
export function allocationSummary(decision: AllocationDecision) {
  return {
    choice: decision.selectedInstanceId ?? decision.outcome,
    reason: decision.reasons.join(" "),
    eligible: decision.candidates.filter((c) => c.eligible).length,
    excluded: decision.candidates.filter((c) => !c.eligible).length,
    confidence: decision.confidence,
  };
}
