import type { ModelRoutingPolicy, ModelRoutingRequest, RoutingProfile } from "@t3tools/contracts";
import * as Cause from "effect/Cause";

export function modelFailureMessage(cause: Cause.Cause<unknown> | undefined) {
  if (!cause) return "Request failed.";
  const failure = Cause.squash(cause);
  return failure instanceof Error ? failure.message : "Request failed.";
}

export const modelProfileLabel = (profile: RoutingProfile) =>
  `${profile.model} / ${profile.effort}`;
export const modelPreviewKey = (
  policy: ModelRoutingPolicy,
  request: ModelRoutingRequest,
  connection: string,
) => JSON.stringify({ policy, request, connection });

/** Uses the selected environment's reachable web origin, never a baked-in localhost. */
export function modelEditorUrl(displayUrl: string | null, environmentId: string) {
  if (!displayUrl || !/^https?:|^wss?:/i.test(displayUrl)) return null;
  const url = new URL(displayUrl);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  url.pathname = "/settings/model-selection";
  url.search = `?machine=${encodeURIComponent(environmentId)}`;
  url.hash = "";
  return url.toString();
}
