// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { type EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as SessionMoves from "../moves/SessionMoves.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerRequests from "../peer/PeerRequests.ts";
import { defaultProviders, layerWorld } from "./integration.testkit.ts";
import { provider } from "./WorkerService.testkit.ts";

type Handler = PeerRequests.PeerRequests["Service"]["handle"];

/** The links between the computers of one test: each computer's request handler and the outages to play. */
export interface Network {
  readonly handlers: Map<string, Handler>;
  /** Peer operations that fail once as an outage, keyed by the operation or request name. */
  readonly outages: Set<string>;
  /** Operations the other computer carries out, but whose answer never arrives. */
  readonly lostReplies: Set<string>;
}
export const newNetwork = (): Network => ({
  handlers: new Map(),
  outages: new Set(),
  lostReplies: new Set(),
});

const requestName = (topic: string, body: unknown) => {
  const named = body as { readonly op?: string; readonly _tag?: string };
  return named.op ?? named._tag ?? topic;
};

const layerPeers = (self: EnvironmentId, other: EnvironmentId, network: Network) =>
  Layer.mergeAll(
    Layer.mock(PeerLinks.PeerLinks)({
      list: Effect.succeed([{ environmentId: other, label: `Peer ${other}` } as never]),
    }),
    Layer.effect(
      PeerRequests.PeerRequests,
      Effect.sync(() => {
        const topics = new Map<string, PeerRequests.PeerRequestHandler>();
        const handle: Handler = (from, topic, body) => {
          const handler = topics.get(topic);
          return handler
            ? handler(from, body)
            : Effect.fail(new OrchestratorMcpFailure({ code: "invalid_request", message: topic }));
        };
        network.handlers.set(self, handle);
        return PeerRequests.PeerRequests.of({
          register: (topic, handler) => Effect.sync(() => void topics.set(topic, handler)),
          handle,
          call: (environmentId, topic, body) => {
            if (network.outages.delete(requestName(topic, body)))
              return Effect.fail(
                new PeerRequests.PeerUnavailable({ environmentId, message: "offline" }),
              );
            const answered = network.handlers.get(environmentId)!(self, topic, body).pipe(
              Effect.mapError((cause) => new PeerRequests.PeerRejected({ message: cause.message })),
            );
            return network.lostReplies.delete(requestName(topic, body))
              ? Effect.andThen(
                  answered,
                  Effect.fail(new PeerRequests.PeerUnavailable({ environmentId, message: "lost" })),
                )
              : answered;
          },
        });
      }),
    ),
  );

const tmp = (name: string) =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `t3-peer-${name}-`));
const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

const layerComputer = (
  self: EnvironmentId,
  other: EnvironmentId,
  network: Network,
  root: string,
  codexHome: string,
  dshHome: string,
  claudeHome: string,
) => {
  const peers = layerPeers(self, other, network);
  return SessionMoves.layer.pipe(
    Layer.provideMerge(
      EventStore.layerFromOrchestrationEventStore.pipe(
        Layer.provide(RuntimeLayer.layerEventInfrastructure),
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(root, { prefix: `t3-peer-${self}-` })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      layerWorld(providers, {
        environmentId: self,
        label: `Peer ${self}`,
        workspaceRoot: root,
        codexHome,
        dshHome,
        claudeHome,
        peers,
      }),
    ),
    Layer.provideMerge(peers),
  );
};

/** DeepSeek Harness lists its models under the live name and keeps the retired name as an alias. */
const deepseek = {
  ...provider("deepseekHarness", "deepseek-v4.1-flash"),
  models: [
    {
      slug: "deepseek-v4.1-flash",
      name: "V4.1 Flash",
      aliases: ["deepseek-v4-flash"],
      isCustom: false,
      capabilities: null,
    },
  ],
};
const providers = [...defaultProviders, deepseek, provider("claudeAgent", "claude-sonnet")];

export interface Computer {
  readonly context: import("effect/Context").Context<
    Layer.Success<ReturnType<typeof layerComputer>>
  >;
  readonly root: string;
  readonly codexHome: string;
  readonly dshHome: string;
  readonly claudeHome: string;
}

/** A whole T3 server in memory, linked to `other` through `network`, with a git checkout and a Codex home. */
export const makeComputer = Effect.fn("makeComputer")(function* (
  self: EnvironmentId,
  other: EnvironmentId,
  network: Network,
) {
  const slug = self.replace(/\W/g, "");
  const root = tmp(slug);
  git(root, "init", "-q", "-b", "main");
  NodeFS.writeFileSync(NodePath.join(root, "README.md"), "hello\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "initial");
  const codexHome = tmp(`${slug}-codex`);
  const dshHome = tmp(`${slug}-dsh`);
  const claudeHome = tmp(`${slug}-claude`);
  const scope = yield* Effect.scope;
  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => {
      NodeFS.rmSync(root, { recursive: true, force: true });
      NodeFS.rmSync(codexHome, { recursive: true, force: true });
      NodeFS.rmSync(dshHome, { recursive: true, force: true });
      NodeFS.rmSync(claudeHome, { recursive: true, force: true });
    }),
  );
  const context = yield* Layer.build(
    layerComputer(self, other, network, root, codexHome, dshHome, claudeHome),
  );
  return { context, root, codexHome, dshHome, claudeHome } satisfies Computer;
});

/** Runs an effect on one computer of a test. */
export const on = <A, E, R>(computer: Computer, effect: Effect.Effect<A, E, R>) =>
  Effect.provideContext(effect, computer.context);
