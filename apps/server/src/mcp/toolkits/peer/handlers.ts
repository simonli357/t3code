import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as PeerRequests from "../../../peer/PeerRequests.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { PeerToolkit } from "./tools.ts";

const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

/**
 * Requests come from another environment's link, paired with full access, and name an
 * environment this one is also linked to: the answer goes back through that link.
 */
export const layer = McpToolAccess.toLayer(PeerToolkit, {
  t3_peer_request: McpToolAccess.reads(({ from, topic, body }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (scope.client?.linked !== true || scope.client.access !== "full-access")
        return yield* denied(
          "Only a linked environment paired with full access may send peer requests.",
        );
      const links = yield* PeerLinks.PeerLinks;
      const known = yield* links
        .get(from)
        .pipe(Effect.mapError(() => denied("Linked environments could not be read here.")));
      if (known._tag === "None")
        return yield* denied("That environment is not linked here. Link it from this side too.");
      const requests = yield* PeerRequests.PeerRequests;
      return { result: yield* requests.handle(from, topic, body) };
    }),
  ),
});
