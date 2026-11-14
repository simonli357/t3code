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
  const retainedWorkspace =
    !job && launchEnvironment?.WORKENV_JOB_ROOT && launchEnvironment.WORKENV_JOB_REPO === workspace
      ? {
          root: launchEnvironment.WORKENV_JOB_ROOT,
          cwd: workspace,
          launchEnvironment,
          retention:
            "Retained session outside automatic job expiry. Use this existing workspace and workenv placement for generated work.",
        }
      : undefined;
  if (!active && !previouslySubmitted && !job && !retainedWorkspace) return undefined;
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
    ...(retainedWorkspace ? { retainedWorkspace } : {}),
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
  const digest = NodeCrypto.createHash("sha256")
    .update(instructions)
    .update("\0")
    .update(runtimeFacts)
    .digest("hex");
  return { revision, digest, active, context: { instructions, runtimeFacts } };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Names the provider context a snapshot lands in, or undefined when the provider cannot tell
 * T3 that its context was replaced; those providers get the snapshot every turn. Claude gives
 * every fresh context a new native session id (new session, fork, rollback, failed resume)
 * and reports compaction and in-session resets, which bump `globalInstructionsContextReset`.
 * A session move or another account also makes a new context.
 */
export function globalInstructionContextKey(
  binding:
    | {
        readonly provider: string;
        readonly providerInstanceId?: string | undefined;
        readonly resumeCursor?: unknown;
        readonly runtimePayload?: unknown;
      }
    | undefined,
) {
  if (binding?.provider !== "claudeAgent") return undefined;
  const sessionId = isRecord(binding.resumeCursor) ? binding.resumeCursor.resume : undefined;
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
  const payload = isRecord(binding.runtimePayload) ? binding.runtimePayload : {};
  return JSON.stringify([
    binding.providerInstanceId ?? null,
    sessionId,
    payload.globalInstructionsContextReset ?? null,
    payload.nativeSessionMove ?? null,
  ]);
}

/** Only a record naming this exact snapshot and context proves the context holds it. */
export function globalInstructionsDelivered(
  runtimePayload: unknown,
  digest: string,
  contextKey: string | undefined,
) {
  const last = isRecord(runtimePayload) ? runtimePayload.globalInstructionsSubmission : undefined;
  return (
    contextKey !== undefined &&
    isRecord(last) &&
    last.digest === digest &&
    last.contextKey === contextKey
  );
}

/** User-context fallback for providers without keyed, replaceable turn context. */
export function appendGlobalInstructionContext(
  prompt: string | undefined,
  context: { readonly instructions: string; readonly runtimeFacts: string },
) {
  return `${prompt ?? "Continue."}\n\n${context.instructions}\n\nT3 host runtime facts (separate from global instructions):\n${context.runtimeFacts}`;
}
