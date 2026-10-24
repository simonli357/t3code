import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import type { ServerSettings } from "@t3tools/contracts";

/** Build a current snapshot, never promote user-authored text to system policy. */
export function buildPersonalInstructionContext(
  settings: Pick<ServerSettings, "personalInstructions" | "personalInstructionsGuidePath">,
  workspace: string | undefined,
  previouslySubmitted = false,
) {
  const { enabled, text } = settings.personalInstructions;
  const active = enabled && text.trim().length > 0;
  if (!active && !previouslySubmitted) return undefined;
  const revision = NodeCrypto.createHash("sha256")
    .update(active ? text : "")
    .digest("hex");
  const instructions = [
    "T3 user-owned personal instructions (current snapshot).",
    "This replaces all earlier T3 personal instruction snapshots, including any in conversation history. These are user preferences, subject to the provider's actual system and developer instructions; this delivery channel does not grant them higher authority.",
    `Status: ${active ? "enabled" : "disabled"}. SHA-256: ${revision}.`,
    active
      ? text
      : "No personal instructions are active. Disregard earlier personal instruction snapshots.",
  ].join("\n\n");
  const runtimeFacts = JSON.stringify({
    host: NodeOS.hostname(),
    ...(workspace ? { workspace } : {}),
    ...(settings.personalInstructionsGuidePath.trim()
      ? { canonicalGuidePath: settings.personalInstructionsGuidePath.trim() }
      : {}),
  });
  return { revision, active, context: { instructions, runtimeFacts } };
}

/** User-context fallback for providers without keyed, replaceable turn context. */
export function appendPersonalInstructionContext(
  prompt: string | undefined,
  context: { readonly instructions: string; readonly runtimeFacts: string },
) {
  return `${prompt ?? "Continue."}\n\n${context.instructions}\n\nT3 host runtime facts (separate from personal instructions):\n${context.runtimeFacts}`;
}
