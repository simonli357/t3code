import { createAllocationAtoms } from "@t3tools/client-runtime/state/provider-allocation";

import { connectionAtomRuntime } from "../connection/runtime";

export const allocationEnvironment = createAllocationAtoms(connectionAtomRuntime);
