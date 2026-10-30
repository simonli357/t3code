import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createAllocationAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    execute: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:provider-allocation",
      tag: WS_METHODS.providerAllocation,
    }),
    /** Accounts, quota readings and policy of one computer. */
    snapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:provider-allocation:snapshot",
      tag: WS_METHODS.providerAllocation,
      staleTimeMs: 5_000,
    }),
  };
}
