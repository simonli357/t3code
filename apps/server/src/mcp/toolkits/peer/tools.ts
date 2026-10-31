import { EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as PeerRequests from "../../../peer/PeerRequests.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const peerRequest = Tool.make("t3_peer_request", {
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    PeerLinks.PeerLinks,
    PeerRequests.PeerRequests,
  ],
  description:
    "Server-to-server channel between linked T3 environments (moves, worker delivery, ownership). Only a full-access link may call it; agents never do.",
  parameters: Schema.Struct({
    from: EnvironmentId,
    topic: Schema.String.check(Schema.isMaxLength(64)),
    body: Schema.Unknown,
  }),
  success: Schema.Struct({ result: Schema.Unknown }),
}).annotate(Tool.Destructive, true);

export const PeerToolkit = Toolkit.make(peerRequest);
