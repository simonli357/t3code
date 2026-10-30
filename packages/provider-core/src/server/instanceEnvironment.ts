import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomePath } from "./pathExpansion.ts";
import type { ProviderAdapterV2RuntimePolicy } from "./ProviderAdapter.ts";

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const home = yield* HostProcess.HomeDirectory;
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  return next;
});

/**
 * Apply the environment owned by a managed workspace at the provider process boundary.
 * Provider-instance values keep their existing precedence, but the workspace identity cannot be
 * redirected by ambient or provider configuration.
 */
export function mergeWorkspaceEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  runtimePolicy: ProviderAdapterV2RuntimePolicy,
): NodeJS.ProcessEnv {
  const workspaceEnvironment = runtimePolicy.workspaceEnvironment;
  if (workspaceEnvironment === undefined) return baseEnv;
  const next: NodeJS.ProcessEnv = { ...workspaceEnvironment, ...baseEnv };
  for (const [name, value] of Object.entries(workspaceEnvironment)) {
    if (name.startsWith("T3_WORKSPACE_") || name.startsWith("WORKENV_JOB_")) {
      next[name] = value;
    }
  }
  return next;
}
