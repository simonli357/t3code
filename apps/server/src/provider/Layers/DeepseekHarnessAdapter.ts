/** DeepSeek Harness over its official persistent ACP profile. */

import {
  ApprovalRequestId,
  type DeepseekHarnessSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSetupError,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { ServerConfig } from "../../config.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  applyDeepseekHarnessModelSelection,
  buildDeepseekHarnessPrompt,
  makeDeepseekHarnessAcpRuntime,
} from "../acp/DeepseekHarnessAcpSupport.ts";
import { type DeepseekHarnessAdapterShape } from "../Services/DeepseekHarnessAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const PROVIDER = ProviderDriverKind.make("deepseekHarness");
const DSH_RESUME_VERSION = 1 as const;

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface DeepseekHarnessAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Selections are honored when `modelSelection.instanceId` matches this value.
   * Defaults to the built-in instance id.
   */
  readonly instanceId?: ProviderInstanceId;
  /**
   * Optional per-session settings resolver. When provided the adapter yields
   * this effect at the start of every session and uses the result instead of
   * the `deepseekHarnessSettings` captured at construction.
   *
   * Production instances bind settings to the instance scope (the hydration
   * layer rebuilds the adapter on config change) and leave this undefined.
   * Test suites that mutate `ServerSettingsService` mid-flight — e.g. to
   * swap `binaryPath` to a mock ACP wrapper — pass a resolver that reads
   * the latest snapshot so the closure isn't stale.
   */
  readonly resolveSettings?: Effect.Effect<DeepseekHarnessSettings>;
  readonly dshHome: string;
  readonly readApiKey: Effect.Effect<string | undefined, ProviderSetupError>;
  readonly onAvailableCommands?: (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
    cwd: string,
  ) => Effect.Effect<void>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface DeepseekHarnessSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Number of sendTurn prompts currently in flight or being prepared.
   * >0 means a turn is actively running, so a new sendTurn is a steer that
   * continues it, and only the last remaining prompt settles the turn. */
  promptsInFlight: number;
  readonly promptLifecycle: Semaphore.Semaphore;
  stopped: boolean;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingApprovals.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDeepseekHarnessResume(
  raw: unknown,
): { sessionId: string; ancestry?: ReadonlyArray<string> } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== DSH_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  const ancestry = Array.isArray(raw.ancestry)
    ? [
        ...new Set(
          raw.ancestry.filter(
            (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
          ),
        ),
      ]
    : [];
  return {
    sessionId: raw.sessionId.trim(),
    ...(ancestry.length > 0 ? { ancestry } : {}),
  };
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
  runtimeMode: RuntimeMode,
): string | undefined {
  const canAutoApprove =
    runtimeMode === "full-access" ||
    (runtimeMode === "auto-accept-edits" && request.toolCall.kind === "edit");
  if (!canAutoApprove) return undefined;
  return (
    request.options.find((option) => option.kind === "allow_always")?.optionId ??
    request.options.find((option) => option.kind === "allow_once")?.optionId
  );
}

export function deepseekHarnessPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  return request.options.find((option) => option.kind === kind)?.optionId;
}

export function makeDeepseekHarnessAdapter(
  deepseekHarnessSettings: DeepseekHarnessSettings,
  options: DeepseekHarnessAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("deepseekHarness");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options.nativeEventLogger ??
      (options.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, DeepseekHarnessSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate DeepSeek Harness runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (
      threadId: ThreadId,
      method: string,
      payload: unknown,
      _source: "acp.jsonrpc",
    ) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const emitPlanUpdate = (
      ctx: DeepseekHarnessSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      source: "acp.jsonrpc",
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source,
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<DeepseekHarnessSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: DeepseekHarnessSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const makeRuntime = Effect.fn("DeepseekHarnessAdapter.makeRuntime")(function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly resumeSessionId?: string;
      readonly clientName: string;
      readonly workspaceEnvironment?: Readonly<Record<string, string>>;
      readonly mcpSession?: ReturnType<typeof McpProviderSession.readMcpProviderSession>;
      readonly resumeMeta?: Record<string, unknown>;
    }) {
      const effectiveSettings = options?.resolveSettings
        ? yield* options.resolveSettings
        : deepseekHarnessSettings;
      const apiKey = yield* options.readApiKey.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "credential/read",
              detail: cause.detail,
              cause,
            }),
        ),
      );
      if (!apiKey) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "credential/read",
          detail: "Add a DeepSeek API key in the DeepSeek Harness provider settings.",
        });
      }
      return yield* makeDeepseekHarnessAcpRuntime({
        settings: effectiveSettings,
        dshHome: options.dshHome,
        apiKey,
        ...(options?.environment ? { baseEnvironment: options.environment } : {}),
        ...(input.mcpSession?.agentDeviceEnvironment
          ? { agentDeviceEnvironment: input.mcpSession.agentDeviceEnvironment }
          : {}),
        ...(input.workspaceEnvironment ? { workspaceEnvironment: input.workspaceEnvironment } : {}),
        childProcessSpawner,
        cwd: input.cwd,
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        ...(input.resumeMeta ? { resumeMeta: input.resumeMeta } : {}),
        clientInfo: { name: input.clientName, version: "0.0.0" },
        ...(input.mcpSession
          ? {
              mcpServers: [
                {
                  type: "http" as const,
                  name: "t3-code",
                  url: input.mcpSession.endpoint,
                  headers: [
                    {
                      name: "Authorization",
                      value: input.mcpSession.authorizationHeader,
                    },
                  ],
                },
              ],
            }
          : {}),
        ...makeAcpNativeLoggers({
          nativeEventLogger,
          provider: PROVIDER,
          threadId: input.threadId,
        }),
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: cause.message,
              cause,
            }),
        ),
      );
    });

    const startSession: DeepseekHarnessAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: DeepseekHarnessSessionContext;

          const resumed = parseDeepseekHarnessResume(input.resumeCursor);
          const resumeSessionId = resumed?.sessionId;
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const acp = yield* makeRuntime({
            threadId: input.threadId,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            resumeMeta: { dshRelocate: true },
            clientName: "t3-code",
            ...(input.workspaceEnvironment
              ? { workspaceEnvironment: input.workspaceEnvironment }
              : {}),
            ...(mcpSession ? { mcpSession } : {}),
          }).pipe(Effect.provideService(Scope.Scope, sessionScope));
          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                const autoApprovedOptionId = selectAutoApprovedPermissionOption(
                  params,
                  input.runtimeMode,
                );
                if (autoApprovedOptionId !== undefined) {
                  return {
                    outcome: {
                      outcome: "selected" as const,
                      optionId: autoApprovedOptionId,
                    },
                  };
                }
                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.make(
                  yield* randomUUIDv4.pipe(
                    Effect.mapError(
                      (cause) =>
                        new EffectAcpErrors.AcpTransportError({
                          detail: "Could not allocate a permission request id.",
                          cause,
                        }),
                    ),
                  ),
                );
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                pendingApprovals.set(requestId, {
                  decision,
                  kind: permissionRequest.kind,
                });
                yield* offerRuntimeEvent(
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    detail:
                      permissionRequest.detail ??
                      encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                      "[unserializable params]",
                    args: params,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: params,
                  }),
                );
                const resolved = yield* Deferred.await(decision);
                pendingApprovals.delete(requestId);
                yield* offerRuntimeEvent(
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: resolved,
                  }),
                );
                if (resolved === "cancel") {
                  return { outcome: { outcome: "cancelled" as const } };
                }
                const optionId = deepseekHarnessPermissionOptionId(params, resolved);
                return optionId === undefined
                  ? { outcome: { outcome: "cancelled" as const } }
                  : { outcome: { outcome: "selected" as const, optionId } };
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new EffectAcpErrors.AcpTransportError({
                      detail: "DeepSeek Harness permission handling failed.",
                      cause,
                    }),
                ),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          const resolvedModel = yield* applyDeepseekHarnessModelSelection({
            runtime: acp,
            model: modelSelection?.model,
            reasoningEffort:
              getModelSelectionStringOptionValue(modelSelection, "reasoning_effort") ??
              getModelSelectionStringOptionValue(modelSelection, "reasoningEffort"),
            mapError: (cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_config_option", cause),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: resolvedModel ?? modelSelection?.model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: DSH_RESUME_VERSION,
              sessionId: started.sessionId,
              ...(resumed?.ancestry ? { ancestry: resumed.ancestry } : {}),
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            promptsInFlight: 0,
            promptLifecycle: yield* Semaphore.make(1),
            stopped: false,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "EventStreamBarrier":
                    yield* Deferred.succeed(event.acknowledge, undefined);
                    return;
                  case "ModeChanged":
                  case "ConfigOptionsUpdated":
                    return;
                  case "AvailableCommandsUpdated":
                    yield* (
                      options?.onAvailableCommands?.(event.availableCommands, cwd) ?? Effect.void
                    );
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* emitPlanUpdate(
                      ctx,
                      event.payload,
                      event.rawPayload,
                      "acp.jsonrpc",
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ThoughtDelta":
                    // Thoughts are narration, not the reply: they stay out of
                    // `assistantReply` so a resumed turn replays only answers.
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        streamKind: "reasoning_text",
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        ...(event.retracted === true ? { retracted: true } : {}),
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "UsageUpdated":
                    yield* offerRuntimeEvent({
                      type: "thread.token-usage.updated",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      payload: {
                        usage: {
                          usedTokens: event.usedTokens,
                          maxTokens: event.maxTokens,
                          lastUsedTokens: event.usedTokens,
                          compactsAutomatically: true,
                        },
                      },
                      raw: {
                        source: "acp.jsonrpc",
                        method: "session/update",
                        payload: event.rawPayload,
                      },
                    });
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Cursor runtime notification.", { cause }),
            ),
            // Fork into the session scope, not the calling fiber. `forkChild`
            // makes this a child of `startSession`, and Effect interrupts a
            // fiber's children when it completes, so the consumer died as soon
            // as `startSession` returned and every later notification was
            // dropped. The scope is created, stored on the context and closed
            // on teardown already; only the fork target was wrong.
            Effect.forkIn(ctx.scope),
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Cursor ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: DeepseekHarnessAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // A sendTurn while a prompt is in flight is a steer: the agent folds
        // the new prompt into the ongoing work, so the active turn id is
        // reused instead of opening a new turn.
        const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
        const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
        // Count this prompt immediately so a superseded in-flight prompt
        // resolving from here on does not settle the turn; the matching
        // decrement is the `ensuring` below.
        ctx.promptsInFlight += 1;

        return yield* Effect.gen(function* () {
          const turnModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const model = turnModelSelection?.model ?? ctx.session.model;
          const resolvedModel = yield* applyDeepseekHarnessModelSelection({
            runtime: ctx.acp,
            model,
            reasoningEffort:
              getModelSelectionStringOptionValue(turnModelSelection, "reasoning_effort") ??
              getModelSelectionStringOptionValue(turnModelSelection, "reasoningEffort"),
            mapError: (cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_config_option", cause),
          });
          ctx.activeTurnId = turnId;
          if (steeringTurnId === undefined) {
            ctx.lastPlanFingerprint = undefined;
          }
          ctx.session = {
            ...ctx.session,
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
          };

          if (steeringTurnId === undefined) {
            yield* offerRuntimeEvent({
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: { model: resolvedModel },
            });
          }

          const rawPrompt = input.input?.trim() ?? "";
          const promptParts = yield* buildDeepseekHarnessPrompt({
            input: input.input,
            attachments: input.attachments,
            attachmentsDir: serverConfig.attachmentsDir,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", cause),
            ),
          );

          if (promptParts.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }

          if (steeringTurnId !== undefined) {
            yield* Effect.ignore(ctx.acp.cancel);
          }
          const result = yield* ctx.promptLifecycle.withPermit(
            ctx.acp
              .prompt({
                prompt: [
                  ...promptParts,
                  {
                    type: "text",
                    text: buildRuntimeInstructions({
                      harness: "DeepSeek Harness",
                      model: resolvedModel ?? model,
                    }),
                  },
                ],
              })
              .pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
                ),
              ),
          );

          yield* ctx.acp.drainEvents;

          const turnRecord = ctx.turns.find((turn) => turn.id === turnId);
          if (turnRecord) {
            turnRecord.items.push({ prompt: promptParts, result });
          } else {
            ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
          }
          ctx.session = {
            ...ctx.session,
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
            model: resolvedModel ?? model,
          };

          // Only the last remaining prompt settles the turn — a steer-
          // superseded prompt resolving (usually cancelled) while another is
          // in flight or pending must leave the merged turn running.
          if (ctx.promptsInFlight === 1) {
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: {
                state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                stopReason: result.stopReason ?? null,
              },
            });
          }

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
              // A settled turn must not keep blocking account or provider switches.
              if (ctx.promptsInFlight === 0) {
                const { activeTurnId: _settled, ...session } = ctx.session;
                ctx.session = session;
              }
            }),
          ),
        );
      });

    const forkConversation: NonNullable<DeepseekHarnessAdapterShape["forkConversation"]> =
      Effect.fn("DeepseekHarnessAdapter.forkConversation")(function* (threadId, target) {
        const existing = sessions.get(threadId);
        const cursor = existing
          ? parseDeepseekHarnessResume(existing.session.resumeCursor)
          : undefined;
        if (existing && existing.promptsInFlight > 0) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/fork",
            detail: "Wait for the current DeepSeek Harness turn to finish before forking.",
          });
        }

        const requestFork = (
          acp: AcpSessionRuntime.AcpSessionRuntime["Service"],
          sessionId: string,
          ancestry: ReadonlyArray<string> = [],
        ) => {
          const cwd = target?.cwd ?? existing?.session.cwd;
          if (!cwd) {
            return Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/fork",
                detail: "The source DeepSeek Harness session has no workspace.",
              }),
            );
          }
          return acp
            .request("session/fork", {
              sessionId,
              cwd,
              mcpServers: [],
              _meta: { dshRelocate: true, dshAncestry: ancestry },
            })
            .pipe(
              Effect.mapError((cause) =>
                mapAcpToAdapterError(PROVIDER, threadId, "session/fork", cause),
              ),
              Effect.flatMap((response) => {
                if (!isRecord(response) || typeof response.sessionId !== "string") {
                  return Effect.fail(
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "session/fork",
                      detail: "DeepSeek Harness returned no forked session identity.",
                    }),
                  );
                }
                const meta = isRecord(response._meta) ? response._meta : {};
                const returnedAncestry = Array.isArray(meta.dshAncestry)
                  ? meta.dshAncestry.filter(
                      (entry): entry is string =>
                        typeof entry === "string" && entry.trim().length > 0,
                    )
                  : [];
                const childSessionId = response.sessionId;
                // The fork is activated on the source connection. Release that
                // activation before T3 starts the child in its own thread; two
                // live processes must never write the same native session.
                return acp.request("session/close", { sessionId: childSessionId }).pipe(
                  Effect.mapError((cause) =>
                    mapAcpToAdapterError(PROVIDER, threadId, "session/close", cause),
                  ),
                  Effect.as({
                    schemaVersion: DSH_RESUME_VERSION,
                    sessionId: childSessionId,
                    ancestry:
                      returnedAncestry.length > 0
                        ? [...new Set(returnedAncestry)]
                        : [...new Set([sessionId, ...ancestry])],
                  }),
                );
              }),
            );
        };

        if (existing && cursor)
          return yield* requestFork(existing.acp, cursor.sessionId, cursor.ancestry);
        const source = parseDeepseekHarnessResume(existing?.session.resumeCursor ?? undefined);
        if (!source && existing) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/fork",
            detail: "The active DeepSeek Harness session has no resumable native identity.",
          });
        }
        if (!source) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/fork",
            detail: "The source DeepSeek Harness session is not active.",
          });
        }
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const acp = yield* makeRuntime({
              threadId,
              cwd: target?.cwd ?? process.cwd(),
              clientName: "t3-code-fork",
              resumeSessionId: source.sessionId,
              ...(target?.workspaceEnvironment
                ? { workspaceEnvironment: target.workspaceEnvironment }
                : {}),
            });
            yield* acp
              .initialize()
              .pipe(
                Effect.mapError((cause) =>
                  mapAcpToAdapterError(PROVIDER, threadId, "initialize", cause),
                ),
              );
            return yield* requestFork(acp, source.sessionId, source.ancestry);
          }),
        );
      });

    const compaction: NonNullable<DeepseekHarnessAdapterShape["compaction"]> = {
      type: "native",
      start: (threadId) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const cursor = parseDeepseekHarnessResume(ctx.session.resumeCursor);
          if (!cursor) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "deepseek-harness/compact",
              detail: "The DeepSeek Harness session has no native identity.",
            });
          }
          yield* ctx.acp
            .request("deepseek-harness/compact", { sessionId: cursor.sessionId })
            .pipe(
              Effect.mapError((cause) =>
                mapAcpToAdapterError(PROVIDER, threadId, "deepseek-harness/compact", cause),
              ),
            );
          yield* offerRuntimeEvent({
            type: "thread.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            payload: { state: "compacted" },
          });
        }),
    };

    const interruptTurn: DeepseekHarnessAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
      });

    const respondToRequest: DeepseekHarnessAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: DeepseekHarnessAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
    ) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/elicitation",
          detail: `DeepSeek Harness has no pending structured user-input request ${requestId}.`,
        });
      });

    const readThread: DeepseekHarnessAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: DeepseekHarnessAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "DeepSeek Harness ACP sessions do not support provider-side rollback.",
        });
      });

    const stopSession: DeepseekHarnessAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: DeepseekHarnessAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: DeepseekHarnessAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: DeepseekHarnessAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to emit DeepSeek Harness session shutdown event.", { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
      compaction,
      startSession,
      sendTurn,
      forkConversation,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies DeepseekHarnessAdapterShape;
  });
}
