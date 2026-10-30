import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";
import { ExecutionEnvironmentPlatformOs } from "./environment.ts";
import { HostResourcesSnapshot } from "./resourceTelemetry.ts";

export const ComputerDisk = Schema.Struct({
  path: Schema.String,
  label: Schema.String,
  totalBytes: Schema.Number,
  availableBytes: Schema.Number,
  freeBytes: Schema.Number,
});
export const COMPUTER_CAPACITY_MAX_DISKS = 16;
/**
 * What an agent needs to choose a computer for new work: a small, bounded slice of the overview,
 * measured when asked. A part that could not be measured is null or absent, never zero.
 */
export const ComputerCapacity = Schema.Struct({
  /** Epoch milliseconds of the oldest measurement below. */
  sampledAt: NonNegativeInt,
  os: ExecutionEnvironmentPlatformOs,
  resources: HostResourcesSnapshot,
  /** The largest disks, with the work disk always among them. */
  disks: Schema.Array(ComputerDisk).check(Schema.isMaxLength(COMPUTER_CAPACITY_MAX_DISKS)),
  /** Mount point in `disks` that holds new agent work; null when it cannot be told. */
  workDisk: Schema.NullOr(Schema.String),
  /** Workenv jobs with a workspace and with a live process; null when workenv cannot be read. */
  jobs: Schema.NullOr(Schema.Struct({ active: NonNegativeInt, running: NonNegativeInt })),
  notices: Schema.Array(Schema.String).check(Schema.isMaxLength(8)),
});
export type ComputerCapacity = typeof ComputerCapacity.Type;
