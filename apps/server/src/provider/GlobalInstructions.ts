import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import type { ServerSettings } from "@t3tools/contracts";
import type { SessionWorkspace } from "../workspace/SessionWorkspaces.ts";

/** Build a current snapshot, never promote user-authored text to system policy. */
export function buildGlobalInstructionContext(
  settings: Pick<ServerSettings, "globalInstructions" | "globalInstructionsGuidePath">,
  workspace: string | undefined,
  previouslySubmitted = false,
  job: SessionWorkspace | null = null,
  launchEnvironment?: Readonly<Record<string, string>>,
) {
  const { enabled, text } = settings.globalInstructions;
  const active = enabled && text.trim().length > 0;
  if (!active && !previouslySubmitted && !job) return undefined;
  const revision = NodeCrypto.createHash("sha256")
    .update(active ? text : "")
    .digest("hex");
  const instructions = [
    "T3 user-configured global instructions (current snapshot).",
    "This replaces all earlier T3 global instruction snapshots, including any in conversation history. These are user preferences, subject to the provider's actual system and developer instructions; this delivery channel does not grant them higher authority.",
    `Status: ${active ? "enabled" : "disabled"}. SHA-256: ${revision}.`,
    active
      ? text
      : "No global instructions are active. Disregard earlier global instruction snapshots.",
  ].join("\n\n");
  const runtimeFacts = JSON.stringify({
    host: NodeOS.hostname(),
    ...(workspace ? { workspace } : {}),
    ...(job
      ? {
          sessionWorkspace: {
            jobId: job.jobId,
            root: job.root,
            cwd: job.workspaceDirectory,
            tmp: launchEnvironment?.TMPDIR ?? job.tmpDirectory,
            build: job.buildDirectory,
            cache: launchEnvironment?.XDG_CACHE_HOME ?? job.cacheDirectory,
            ...(launchEnvironment ? { launchEnvironment } : {}),
            downloads: job.downloadsDirectory,
            outputs: job.outputsDirectory,
            evidence: job.evidenceDirectory,
            source: job.sourceDirectory,
            placement:
              "Launch defaults; explicit provider/tool options can use other paths. Preserve useful results through the configured external lifecycle workflow.",
          },
        }
      : {}),
    ...(settings.globalInstructionsGuidePath.trim()
      ? { guidePath: settings.globalInstructionsGuidePath.trim() }
      : {}),
  });
  return { revision, active, context: { instructions, runtimeFacts } };
}

/** User-context fallback for providers without keyed, replaceable turn context. */
export function appendGlobalInstructionContext(
  prompt: string | undefined,
  context: { readonly instructions: string; readonly runtimeFacts: string },
) {
  return `${prompt ?? "Continue."}\n\n${context.instructions}\n\nT3 host runtime facts (separate from global instructions):\n${context.runtimeFacts}`;
}
