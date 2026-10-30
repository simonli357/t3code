/**
 * PiAdapterShape — per-instance Pi adapter contract.
 *
 * The driver bundles the concrete ACP-backed adapter as a captured closure,
 * so this module only retains the shape interface as a naming anchor.
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface PiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
