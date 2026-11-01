import { ProviderDriverKind, type ServerProviderModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as AcpErrors from "effect-acp/errors";
import {
  forkCursorNativeSession,
  prepareCursorNativeSession,
  discardCursorNativeFork,
} from "./nativeSession.ts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";
import { acpPermissionDisposition } from "@t3tools/provider-acp/server/clientPolicy";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { SelfInvocation } from "@t3tools/shared/nodeRuntime";
import type { CursorSettings } from "../settings.ts";
import { resolveCursorAcpBaseModelId, resolveCursorAcpConfigUpdates } from "./acpModel.ts";
import { cursorContextWindowTokens } from "./sdkModel.ts";

const driver = ProviderDriverKind.make("cursor");

export interface CursorAcpAdapterOptions {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: CursorSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  readonly getModels?: () => ReadonlyArray<ServerProviderModel>;
  readonly readEnvironment?: Effect.Effect<NodeJS.ProcessEnv>;
  readonly makeRuntime?: AcpAdapterV2Flavor["makeRuntime"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
}

/** Match custom.52: workspace paths override ambient paths, then add this thread's MCP binding. */
export function cursorSessionEnvironment(
  environment: NodeJS.ProcessEnv,
  input: Pick<AcpAdapterV2RuntimeInput, "runtimePolicy" | "processEnvironment">,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    ...input.runtimePolicy.workspaceEnvironment,
    ...input.processEnvironment,
  };
}

export function cursorLaunchMode(policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy) {
  // Explicit policies must be enforced by the ACP permission boundary, never --force.
  return policy.approvalPolicy === undefined && policy.sandboxPolicy === undefined
    ? policy.runtimeMode
    : "approval-required";
}

export function cursorAcpSpawn(
  options: Pick<CursorAcpAdapterOptions, "settings" | "environment">,
  input: Pick<AcpAdapterV2RuntimeInput, "cwd" | "runtimePolicy" | "processEnvironment">,
): AcpSessionRuntime.AcpSpawnInput {
  const mode = cursorLaunchMode(input.runtimePolicy);
  return {
    command: options.settings.binaryPath || "cursor-agent",
    args: [
      ...(options.settings.apiEndpoint ? ["-e", options.settings.apiEndpoint] : []),
      ...(mode === "auto" ? ["--auto-review"] : mode === "full-access" ? ["--force"] : []),
      "acp",
    ],
    cwd: input.cwd,
    env: cursorSessionEnvironment(options.environment, input),
    extendEnv: false,
  };
}

const AskQuestion = Schema.Struct({
  toolCallId: Schema.String,
  questions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      prompt: Schema.String,
      options: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
      allowMultiple: Schema.optional(Schema.Boolean),
    }),
  ),
});
const CreatePlan = Schema.Struct({ toolCallId: Schema.String, plan: Schema.String });
const UpdateTodos = Schema.Struct({
  toolCallId: Schema.String,
  todos: Schema.Array(
    Schema.Struct({
      content: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String),
      status: Schema.optional(Schema.String),
    }),
  ),
});

export function cursorAcpFlavor(options: CursorAcpAdapterOptions): AcpAdapterV2Flavor {
  return {
    driver,
    runtimeHarness: "Cursor",
    capabilities: {
      ...AcpProviderCapabilitiesV2,
      sessions: {
        ...AcpProviderCapabilitiesV2.sessions,
        supportsRuntimeModeSwitchInSession: false,
      },
      threads: {
        ...AcpProviderCapabilitiesV2.threads,
        canReadThreadSnapshot: true,
        canForkThread: true,
      },
      checkpointing: {
        ...AcpProviderCapabilitiesV2.checkpointing,
        providerCanReadConversationSnapshot: true,
      },
    },
    clientCapabilitiesMeta: { parameterizedModelPicker: true },
    resolveModelId: (selection) => resolveCursorAcpBaseModelId(selection.model),
    getModelContextWindow: (selection) =>
      cursorContextWindowTokens(selection, options.getModels?.() ?? []),
    applyModelSelection: Effect.fn("CursorAcp.applyModelSelection")(function* ({
      runtime,
      modelSelection,
    }) {
      const model = resolveCursorAcpBaseModelId(modelSelection.model);
      yield* runtime.setModel(model);
      const config = yield* runtime.getConfigOptions;
      for (const update of resolveCursorAcpConfigUpdates(config, modelSelection.options)) {
        yield* runtime.setConfigOption(update.configId, update.value);
      }
      return model;
    }),
    permissionDisposition: (policy, request) =>
      cursorLaunchMode(policy) === "auto" ? "ask" : acpPermissionDisposition(policy, request),
    makeRuntime:
      options.makeRuntime ??
      ((input) =>
        Effect.gen(function* () {
          const environment = options.readEnvironment
            ? yield* options.readEnvironment
            : options.environment;
          const platform = yield* HostProcess.Platform;
          const sessionEnv = cursorSessionEnvironment(environment, input);
          if (input.resumeSessionId)
            yield* prepareNative(
              sessionEnv,
              input.resumeSessionId,
              cursorLaunchMode(input.runtimePolicy),
              platform,
            );
          const context = yield* Layer.build(
            AcpSessionRuntime.layer({
              ...input,
              spawn: cursorAcpSpawn({ ...options, environment }, input),
              authMethodId: "cursor_login",
            }),
          );
          const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
            Effect.provide(context),
          );
          return cursorNativeForkRuntime(
            runtime,
            sessionEnv,
            input.cwd,
            cursorLaunchMode(input.runtimePolicy),
            platform,
          );
        })),
    registerExtensions: Effect.fn("CursorAcp.registerExtensions")(function* ({
      runtime,
      requestUserInput,
      captureProposedPlan,
      updatePlan,
    }) {
      for (const prefix of ["cursor/", "_cursor/"]) {
        yield* runtime.handleExtRequest(`${prefix}ask_question`, AskQuestion, (params, context) =>
          requestUserInput(
            {
              nativeItemId: params.toolCallId,
              nativeRequestId: params.toolCallId,
              questions: params.questions.map((question) => ({
                id: question.id,
                header: "Question",
                question: question.prompt,
                multiSelect: question.allowMultiple === true,
                options: question.options.map((option) => ({
                  label: option.label,
                  description: option.label,
                })),
              })),
            },
            context,
          ).pipe(
            Effect.flatMap(({ answers, acknowledgeNativeResponse }) =>
              acknowledgeNativeResponse.pipe(Effect.as({ answers: answers ?? {} })),
            ),
          ),
        );
        yield* runtime.handleExtRequest(`${prefix}create_plan`, CreatePlan, (params) =>
          captureProposedPlan({ planMarkdown: params.plan }).pipe(Effect.as({ accepted: true })),
        );
        yield* runtime.handleExtNotification(`${prefix}update_todos`, UpdateTodos, (params) =>
          updatePlan({
            nativePlanId: params.toolCallId,
            kind: "items",
            plan: params.todos.flatMap((todo) => {
              const step = todo.content?.trim() || todo.title?.trim();
              return step
                ? [
                    {
                      step,
                      status:
                        todo.status === "completed"
                          ? "completed"
                          : todo.status === "in_progress" || todo.status === "inProgress"
                            ? "inProgress"
                            : "pending",
                    },
                  ]
                : [];
            }),
          }),
        );
      }
    }),
  };
}

// Local SDK 1.0.38 has no environment boundary and uses a different native store. ACP keeps
// the CLI's session IDs and complete native history without rebuilding a V1 orchestration engine.
export const makeCursorAcpAdapter = (options: CursorAcpAdapterOptions) =>
  makeAcpAdapterV2({
    instanceId: options.instanceId,
    selfInvocation: options.selfInvocation,
    flavor: cursorAcpFlavor(options),
    ...(options.nativeLogging ? { nativeLogging: options.nativeLogging } : {}),
  });

/** The CLI has session/load but no session/fork. The compatibility path snapshots its native store. */
export function cursorNativeForkRuntime(
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  environment: NodeJS.ProcessEnv,
  cwd: string,
  mode: string,
  platform: NodeJS.Platform,
): AcpSessionRuntime.AcpSessionRuntime["Service"] {
  let active = false;
  const idle = (method: string) =>
    Effect.suspend(() =>
      active
        ? Effect.fail(
            new AcpErrors.AcpTransportError({
              method,
              cause: "active-turn",
              detail: "Cannot change an active Cursor turn",
            }),
          )
        : Effect.void,
    );
  const withFork = (result: AcpSessionRuntime.AcpSessionRuntimeStartResult) => ({
    ...result,
    initializeResult: {
      ...result.initializeResult,
      agentCapabilities: {
        ...result.initializeResult.agentCapabilities,
        sessionCapabilities: {
          ...result.initializeResult.agentCapabilities?.sessionCapabilities,
          fork: {},
        },
      },
    },
  });
  return {
    ...runtime,
    start: () => runtime.start().pipe(Effect.map(withFork)),
    loadSession: (id, activation) =>
      idle("session/load").pipe(
        Effect.andThen(prepareNative(environment, id, mode, platform)),
        Effect.andThen(runtime.loadSession(id, activation)),
        Effect.map(withFork),
      ),
    prompt: (...args) =>
      Effect.acquireUseRelease(
        idle("session/prompt").pipe(
          Effect.andThen(
            Effect.sync(() => {
              active = true;
            }),
          ),
        ),
        () => runtime.prompt(...args),
        () =>
          Effect.sync(() => {
            active = false;
          }),
      ),
    forkSession: Effect.fn("CursorAcp.forkSession")(function* (id, activation) {
      const forked = yield* Effect.try({
        try: () => {
          if (active) throw new Error("Cannot fork an active Cursor turn.");
          return forkCursorNativeSession(environment, id, cwd, platform);
        },
        catch: (cause) =>
          new AcpErrors.AcpTransportError({
            method: "session/fork",
            cause,
            detail: "Could not copy the complete Cursor native session",
          }),
      });
      return yield* prepareNative(environment, forked, mode, platform).pipe(
        Effect.andThen(runtime.loadSession(forked, activation)),
        Effect.map(withFork),
        Effect.onError(() =>
          Effect.try(() => discardCursorNativeFork(environment, forked, platform)).pipe(
            Effect.ignore,
          ),
        ),
      );
    }),
  };
}

const prepareNative = (
  environment: NodeJS.ProcessEnv,
  id: string,
  mode: string,
  platform: NodeJS.Platform,
) =>
  Effect.try({
    try: () => prepareCursorNativeSession(environment, id, mode, platform),
    catch: (cause) =>
      new AcpErrors.AcpTransportError({
        method: "session/load",
        cause,
        detail: cause instanceof Error ? cause.message : "Cursor native session could not be read",
      }),
  });
