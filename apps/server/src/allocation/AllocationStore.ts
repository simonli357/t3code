import {
  AllocationError,
  AllocationPolicy,
  AllocationReservation,
  AllocationDecision,
  defaultAllocationPolicy,
  ModelRoutingPolicy,
  ModelRoutingDecision,
  defaultModelRoutingPolicy,
  type ModelRoutingRequest,
  type AllocationInventory,
  type AllocationRequest,
  type AllocationLifecycle,
  type AllocationPolicyUpdate,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { allocationScore, decideAllocation } from "./decision.ts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { modelCandidates, modelPolicyIssues } from "./modelDecision.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const policyJson = Schema.decodeUnknownSync(Schema.fromJsonString(AllocationPolicy));
const reservationJson = Schema.decodeUnknownSync(Schema.fromJsonString(AllocationReservation));
const decisionJson = Schema.decodeUnknownSync(Schema.fromJsonString(AllocationDecision));
// Before startup, the master may choose another account for the same exact task.
// Once a start intent exists, lost responses must replay that identical intent.
export const withoutAccountChoice = <T extends { explicitInstanceId?: unknown }>(request: T) => {
  const { explicitInstanceId: _account, ...rest } = request;
  return stableStringify(rest);
};
const failure = () =>
  new AllocationError({
    code: "persistence",
    detail: "Allocation state could not be read or committed.",
  });

export class AllocationStore extends Context.Service<
  AllocationStore,
  {
    readonly modelPolicy: Effect.Effect<ModelRoutingPolicy, AllocationError>;
    readonly modelPolicies: Effect.Effect<readonly ModelRoutingPolicy[], AllocationError>;
    readonly modelHistory: Effect.Effect<readonly ModelRoutingDecision[], AllocationError>;
    readonly modelDecisionById: (
      id: string,
    ) => Effect.Effect<ModelRoutingDecision | undefined, AllocationError>;
    readonly saveModelPolicy: (input: {
      expectedVersion: number;
      policy?: ModelRoutingPolicy;
      revertVersion?: number;
      inventories: readonly AllocationInventory[];
    }) => Effect.Effect<ModelRoutingPolicy, AllocationError>;
    readonly selectModel: (input: {
      at: string;
      request: ModelRoutingRequest;
      inventories: readonly AllocationInventory[];
      authorityAvailable: boolean;
      reserve: boolean;
      expectedPolicyVersion: number;
      expectedModelVersion: number;
      previewPolicy?: ModelRoutingPolicy;
    }) => Effect.Effect<ModelRoutingDecision, AllocationError>;
    readonly policy: Effect.Effect<AllocationPolicy, AllocationError>;
    readonly reservations: Effect.Effect<readonly AllocationReservation[], AllocationError>;
    readonly history: Effect.Effect<readonly AllocationDecision[], AllocationError>;
    readonly expireUnused: (at: string) => Effect.Effect<void, AllocationError>;
    readonly savePolicy: (
      input: typeof AllocationPolicyUpdate.Type,
    ) => Effect.Effect<AllocationPolicy, AllocationError>;
    readonly allocate: (input: {
      at: string;
      request: AllocationRequest;
      inventories: readonly AllocationInventory[];
      authorityAvailable: boolean;
      reserve: boolean;
      expectedPolicyVersion?: number;
      previewPolicy?: AllocationPolicy;
      stableSelection?: boolean;
    }) => Effect.Effect<
      {
        decision: AllocationDecision;
        reservation: AllocationReservation | null;
        mode: AllocationPolicy["mode"];
      },
      AllocationError
    >;
    readonly lifecycle: (
      input: typeof AllocationLifecycle.Type,
      at: string,
    ) => Effect.Effect<AllocationReservation, AllocationError>;
  }
>()("t3/allocation/AllocationStore") {}

const decodeModelPolicy = Schema.decodeUnknownSync(Schema.fromJsonString(ModelRoutingPolicy));
const decodeModelDecision = Schema.decodeUnknownSync(Schema.fromJsonString(ModelRoutingDecision));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const policy = sql<{
    policy_json: string;
  }>`SELECT policy_json FROM provider_allocation_policy WHERE id = 1`.pipe(
    Effect.map((rows) => (rows[0] ? policyJson(rows[0].policy_json) : defaultAllocationPolicy)),
    Effect.mapError(failure),
  );
  const reservations = sql<{
    reservation_json: string;
  }>`SELECT reservation_json FROM provider_allocation_reservations WHERE state IN ('reserved', 'starting', 'consumed') OR id IN (SELECT id FROM provider_allocation_reservations WHERE state IN ('released', 'expired') ORDER BY rowid DESC LIMIT 100) ORDER BY id`.pipe(
    Effect.map((rows) => rows.map((row) => reservationJson(row.reservation_json))),
    Effect.mapError(failure),
  );
  const reservationById = (id: string) =>
    sql<{
      reservation_json: string;
    }>`SELECT reservation_json FROM provider_allocation_reservations WHERE id = ${id}`.pipe(
      Effect.map((rows) => (rows[0] ? reservationJson(rows[0].reservation_json) : undefined)),
      Effect.mapError(failure),
    );
  const history = sql<{
    decision_json: string;
  }>`SELECT decision_json FROM provider_allocation_decisions ORDER BY id DESC LIMIT 100`.pipe(
    Effect.map((rows) => rows.map((row) => decisionJson(row.decision_json))),
    Effect.mapError(failure),
  );
  const write = (
    r: AllocationReservation,
  ) => sql`INSERT INTO provider_allocation_reservations (id, environment_id, thread_id, state, expires_at, reservation_json)
    VALUES (${r.assignmentId}, ${r.request.environmentId}, ${r.request.threadId}, ${r.state}, ${r.expiresAt}, ${json(r)})
    ON CONFLICT(id) DO UPDATE SET state = excluded.state, expires_at = excluded.expires_at, reservation_json = excluded.reservation_json`;
  const allocate = (input: Parameters<AllocationStore["Service"]["allocate"]>[0]) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* policy;
          if (
            input.expectedPolicyVersion !== undefined &&
            input.expectedPolicyVersion !== current.version
          )
            return yield* new AllocationError({
              code: "conflict",
              detail:
                "Policy changed while host capacity was being collected. Retry with fresh observations.",
            });
          const effective = input.previewPolicy ?? current;
          const stored = [...(yield* reservations)];
          // Only unused reservations expire. A starting operation may have committed
          // remotely; it must be reconciled from execution receipts, never a timeout.
          for (let i = 0; i < stored.length; i++) {
            const r = stored[i]!;
            if (r.state === "reserved" && r.expiresAt <= input.at) {
              stored[i] = { ...r, state: "expired" };
              if (input.reserve) yield* write(stored[i]!);
            }
          }
          const prior =
            stored.find((r) => r.assignmentId === input.request.assignmentId) ??
            (yield* reservationById(input.request.assignmentId));
          if (input.reserve && prior) {
            const unstarted = !prior.startIntent && ["reserved", "expired"].includes(prior.state);
            if (
              unstarted
                ? withoutAccountChoice(prior.request) !== withoutAccountChoice(input.request)
                : stableStringify(prior.request) !== stableStringify(input.request)
            )
              return yield* new AllocationError({
                code: "conflict",
                detail:
                  "Assignment ID already has different model, options, host or started account constraints.",
              });
            if (!unstarted) {
              if (prior.state === "released")
                return yield* new AllocationError({
                  code: "conflict",
                  detail: "This assignment has finished or was cancelled.",
                });
              return { decision: prior.decision, reservation: prior, mode: current.mode };
            }
            if (
              prior.state === "reserved" &&
              stableStringify(prior.request) === stableStringify(input.request)
            )
              return { decision: prior.decision, reservation: prior, mode: current.mode };
          }
          if (
            input.reserve &&
            stored.some(
              (r) =>
                r.assignmentId !== input.request.assignmentId &&
                r.request.environmentId === input.request.environmentId &&
                r.request.threadId === input.request.threadId &&
                ["reserved", "starting", "consumed"].includes(r.state),
            )
          ) {
            return yield* new AllocationError({
              code: "conflict",
              detail: "This thread already has an active allocation.",
            });
          }
          const last = input.stableSelection
            ? undefined
            : (yield* history).find(
                (d) =>
                  d.request.driver === input.request.driver &&
                  d.request.environmentId === input.request.environmentId &&
                  d.selectedInstanceId,
              );
          const previousAccountKey = last?.candidates.find(
            (c) => c.instanceId === last.selectedInstanceId && c.eligible,
          )?.accountKey;
          const replay = {
            ...input,
            policy: effective,
            reservations: stored,
            ...(previousAccountKey ? { previousAccountKey } : {}),
          };
          const decision = decideAllocation(replay);
          const retained = new Set(
            input.inventories.flatMap((i) =>
              i.accounts
                .filter((a) => a.retainHistory)
                .map((a) => `${a.environmentId}:${a.instanceId}`),
            ),
          );
          const retainedDecision = {
            ...decision,
            candidates: decision.candidates.map((c) =>
              retained.has(`${c.environmentId}:${c.instanceId}`)
                ? c
                : { ...c, windows: [], behindPoints: 0, resetInHours: null },
            ),
          };
          const retainedReplay = {
            at: replay.at,
            request: replay.request,
            policy: replay.policy,
            authorityAvailable: replay.authorityAvailable,
            reservations: replay.reservations,
            ...(previousAccountKey ? { previousAccountKey } : {}),
            inventories: replay.inventories.map((i) => ({
              ...i,
              accounts: i.accounts.map((a) =>
                a.retainHistory
                  ? a
                  : {
                      ...a,
                      windows: [],
                      resetCredits: null,
                      limitedUntil: null,
                      profileSamples: 0,
                      profileUncertainty: 1,
                    },
              ),
            })),
            retentionNotice:
              "Quota replay is retained only for accounts opted into UsageMeasurements.",
          };
          if (!input.previewPolicy) {
            yield* sql`INSERT INTO provider_allocation_decisions (created_at, decision_json, replay_json) VALUES (${input.at}, ${json(retainedDecision)}, ${json(retainedReplay)})`;
            yield* sql`DELETE FROM provider_allocation_decisions WHERE id NOT IN (SELECT id FROM provider_allocation_decisions ORDER BY id DESC LIMIT 200)`;
          }
          let reservation: AllocationReservation | null = null;
          const selected = decision.candidates.find(
            (c) => c.eligible && c.instanceId === decision.selectedInstanceId,
          );
          if (input.reserve && selected) {
            reservation = {
              assignmentId: input.request.assignmentId,
              request: input.request,
              accountKey: selected.accountKey,
              instanceId: selected.instanceId,
              createdAt: input.at,
              expiresAt: DateTime.formatIso(
                DateTime.makeUnsafe(Date.parse(input.at) + current.reservationMinutes * 60_000),
              ),
              state: "reserved",
              decision: retainedDecision,
            };
            yield* write(reservation);
          }
          return { decision, reservation, mode: current.mode };
        }),
      )
      .pipe(Effect.catchTag("SqlError", failure));
  const modelPolicy = sql<{
    policy_json: string;
  }>`SELECT policy_json FROM model_selection_policies ORDER BY version DESC LIMIT 1`.pipe(
    Effect.map((rows) =>
      rows[0] ? decodeModelPolicy(rows[0].policy_json) : defaultModelRoutingPolicy,
    ),
    Effect.mapError(failure),
  );
  const modelPolicies = sql<{
    policy_json: string;
  }>`SELECT policy_json FROM model_selection_policies ORDER BY version DESC LIMIT 20`.pipe(
    Effect.map((rows) => rows.map((r) => decodeModelPolicy(r.policy_json))),
    Effect.mapError(failure),
  );
  const modelHistory = sql<{
    decision_json: string;
  }>`SELECT decision_json FROM model_selection_decisions ORDER BY rowid DESC LIMIT 50`.pipe(
    Effect.map((rows) =>
      rows.map((r) => {
        const decision = decodeModelDecision(r.decision_json);
        return {
          ...decision,
          allocation: decision.allocation
            ? {
                ...decision.allocation,
                reservation: null,
                decision: { ...decision.allocation.decision, candidates: [] },
              }
            : null,
        };
      }),
    ),
    Effect.mapError(failure),
  );
  const modelDecisionById = (id: string) =>
    sql<{
      decision_json: string;
    }>`SELECT decision_json FROM model_selection_decisions WHERE assignment_id = ${id}`.pipe(
      Effect.map((rows) => (rows[0] ? decodeModelDecision(rows[0].decision_json) : undefined)),
      Effect.mapError(failure),
    );
  const invalid = (detail: string) => new AllocationError({ code: "invalid", detail });
  const conflict = (detail: string) => new AllocationError({ code: "conflict", detail });
  return AllocationStore.of({
    modelPolicy,
    modelPolicies,
    modelHistory,
    modelDecisionById,
    saveModelPolicy: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* modelPolicy;
            if (input.expectedVersion !== current.version)
              return yield* conflict(
                "Model policy changed. Refresh the saved version while retaining your draft, then review and save again.",
              );
            const reverted =
              input.revertVersion === 0
                ? defaultModelRoutingPolicy
                : input.revertVersion !== undefined
                  ? (yield* sql<{
                      policy_json: string;
                    }>`SELECT policy_json FROM model_selection_policies WHERE version = ${input.revertVersion}`)[0]
                  : undefined;
            const proposed =
              input.policy ??
              (reverted &&
                ("policy_json" in reverted ? decodeModelPolicy(reverted.policy_json) : reverted));
            if (!proposed) return yield* invalid("The requested previous policy is unavailable.");
            const next = { ...proposed, version: current.version + 1 };
            // Reverts restore a known policy, including readable but now-unavailable catalog values.
            const issues = modelPolicyIssues(
              next,
              input.revertVersion === undefined ? current : next,
              input.inventories,
            );
            if (issues.length) return yield* invalid(issues.join(" "));
            yield* sql`INSERT INTO model_selection_policies (version, policy_json) VALUES (${next.version}, ${json(next)})`;
            return next;
          }),
        )
        .pipe(Effect.catchTag("SqlError", failure)),
    selectModel: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const prior = yield* modelDecisionById(input.request.assignmentId);
            const existingReservation = yield* reservationById(input.request.assignmentId);
            if (input.reserve && prior) {
              const started =
                existingReservation?.startIntent || prior.allocation?.reservation?.startIntent;
              if (
                started
                  ? stableStringify(prior.request) !== stableStringify(input.request)
                  : withoutAccountChoice(prior.request) !== withoutAccountChoice(input.request)
              )
                return yield* conflict(
                  "Assignment ID already belongs to a different assessment, profile, host or started intent.",
                );
              if (
                started ||
                (existingReservation &&
                  stableStringify(prior.request) === stableStringify(input.request))
              )
                return prior;
            }
            if (input.reserve && existingReservation && !prior)
              return yield* conflict(
                "This assignment identity already belongs to an explicit allocation.",
              );
            const current = yield* modelPolicy;
            const allocationPolicy = yield* policy;
            if (
              current.version !== input.expectedModelVersion ||
              allocationPolicy.version !== input.expectedPolicyVersion
            )
              return yield* conflict(
                "Policy changed while collecting target catalogs. Refresh and retry.",
              );
            const effective = input.previewPolicy ?? current;
            const retained =
              prior &&
              !input.previewPolicy &&
              withoutAccountChoice(prior.request) === withoutAccountChoice(input.request)
                ? prior
                : undefined;
            if (
              !retained &&
              input.request.policyVersion !== undefined &&
              input.request.policyVersion !== current.version
            )
              return yield* conflict(
                "Model policy changed since preview. Refresh the saved policy and preview again before starting this new assignment.",
              );
            let revision = 0;
            let previous: ModelRoutingDecision | undefined;
            if (input.request.reassessment) {
              previous = yield* modelDecisionById(input.request.reassessment.previousAssignmentId);
              if (!previous || previous.request.assignmentId === input.request.assignmentId)
                return yield* invalid(
                  "Reassessment requires a saved previous assignment and a new identity.",
                );
              if (previous.request.threadId === input.request.threadId)
                return yield* invalid(
                  "Reassessment starts a fresh assignment session; retain the existing session or choose a new destination thread.",
                );
              revision = previous.revision + 1;
              if (!retained && revision > effective.maxReassessments)
                return yield* invalid(
                  "The configured reassessment bound is reached. Review the assignment manually.",
                );
              if (previous.request.environmentId !== input.request.environmentId)
                return yield* invalid(
                  "Reassessment cannot change execution computer. Use the explicit move workflow.",
                );
              if (
                previous.request.explicitInstanceId !== input.request.explicitInstanceId ||
                previous.request.nativeInstanceId !== input.request.nativeInstanceId ||
                stableStringify(previous.request.allowedInstanceIds ?? null) !==
                  stableStringify(input.request.allowedInstanceIds ?? null)
              )
                return yield* invalid(
                  "Reassessment must retain account and native identity constraints.",
                );
              if (previous.request.override && !input.request.override)
                return yield* invalid(
                  "Reassessment cannot discard an exact user override. Retain it or supply a new explicit override with its reason.",
                );
            }
            // Failed reassessments do not grant consent or erase the last selected
            // family. Revisions decrease on each durable predecessor (at most 3).
            let anchor = previous;
            while (anchor && !anchor.allocation && anchor.request.reassessment) {
              const predecessor = yield* modelDecisionById(
                anchor.request.reassessment.previousAssignmentId,
              );
              if (!predecessor || predecessor.revision >= anchor.revision)
                return yield* invalid(
                  "Reassessment lineage is unavailable. Review the previous assignment.",
                );
              anchor = predecessor;
            }
            const resolved = modelCandidates(effective, input.request, input.inventories, retained);
            const proposals = [];
            for (const candidate of resolved.candidates) {
              if (
                anchor?.allocation &&
                anchor.allocation.decision.request.driver !== candidate.request.driver &&
                !input.request.reassessment?.allowFreshProviderSession
              ) {
                resolved.reasons.push(
                  "Changing provider family requires explicit consent to a fresh provider session; native identity cannot be mutated.",
                );
                continue;
              }
              const result = yield* allocate({
                at: input.at,
                inventories: input.inventories,
                authorityAvailable: input.authorityAvailable,
                expectedPolicyVersion: input.expectedPolicyVersion,
                request: candidate.request,
                reserve: false,
                ...(input.reserve ? {} : { previewPolicy: allocationPolicy }),
                stableSelection: true,
              });
              proposals.push({ ...candidate, result });
            }
            const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
            const ranked = proposals
              .flatMap((p) => {
                const c = p.result.decision.candidates.find(
                  (v) => v.eligible && v.instanceId === p.result.decision.selectedInstanceId,
                );
                return c ? [{ p, c }] : [];
              })
              .sort(
                (a, b) =>
                  (a.c.warnings?.length ?? 0) - (b.c.warnings?.length ?? 0) ||
                  allocationScore(b.c, allocationPolicy, b.p.request.driver) -
                    allocationScore(a.c, allocationPolicy, a.p.request.driver) ||
                  (a.c.resetInHours ?? Infinity) - (b.c.resetInHours ?? Infinity) ||
                  compare(a.c.accountKey ?? "", b.c.accountKey ?? "") ||
                  compare(a.c.instanceId, b.c.instanceId) ||
                  compare(a.p.request.driver, b.p.request.driver),
              );
            const chosen = ranked[0]?.p;
            // All families were evaluated against the same inventory/reservations under
            // this SQL transaction. Only its selected exact profile enters admission.
            const allocation = chosen
              ? yield* allocate({
                  at: input.at,
                  inventories: input.inventories,
                  authorityAvailable: input.authorityAvailable,
                  reserve: input.reserve,
                  expectedPolicyVersion: input.expectedPolicyVersion,
                  request: chosen.request,
                  stableSelection: true,
                  ...(input.previewPolicy ? { previewPolicy: allocationPolicy } : {}),
                })
              : null;
            const decision: ModelRoutingDecision = {
              at: input.at,
              policyVersion: retained?.policyVersion ?? effective.version,
              request: input.request,
              revision,
              selectedProfile: chosen?.profile ?? null,
              rule: resolved.rule,
              profiles: proposals.map((p) => ({
                driver: p.request.driver,
                profile: p.profile,
                model: p.request.model,
                options: p.request.options,
                reason: p.reason,
                eligible: p.result.decision.selectedInstanceId !== null,
              })),
              reasons: [
                ...new Set([
                  ...resolved.reasons,
                  ...(chosen
                    ? [chosen.reason, ...chosen.result.decision.reasons]
                    : [
                        "No approved profile/account matches the capability and continuity constraints.",
                      ]),
                  ...proposals.flatMap((p) =>
                    p.result.decision.selectedInstanceId
                      ? []
                      : [
                          p.reason,
                          ...p.result.decision.reasons,
                          ...p.result.decision.candidates.flatMap((c) => c.reasons),
                        ],
                  ),
                ]),
              ].slice(0, 24),
              allocation,
            };
            if (input.reserve) {
              // Diagnostic history contains assessments and choices, never private prompts.
              const retained = allocation
                ? {
                    ...decision,
                    allocation: {
                      ...allocation,
                      decision: allocation.reservation?.decision ?? {
                        ...allocation.decision,
                        candidates: allocation.decision.candidates.map((c) => ({
                          ...c,
                          windows: [],
                          behindPoints: 0,
                          resetInHours: null,
                        })),
                      },
                    },
                  }
                : decision;
              // Keep the original resolved intent until admission commits. Failed
              // attempts are audited in the allocator's bounded decision history.
              if (!prior || allocation?.reservation)
                yield* sql`INSERT INTO model_selection_decisions (assignment_id, created_at, decision_json) VALUES (${input.request.assignmentId}, ${input.at}, ${json(retained)})
                  ON CONFLICT(assignment_id) DO UPDATE SET decision_json = excluded.decision_json`;
              return retained;
            }
            return decision;
          }),
        )
        .pipe(Effect.catchTag("SqlError", failure)),
    policy,
    reservations,
    history,
    expireUnused: (at) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            for (const r of yield* reservations)
              if (r.state === "reserved" && r.expiresAt <= at)
                yield* write({ ...r, state: "expired" });
          }),
        )
        .pipe(Effect.catchTag("SqlError", failure)),
    savePolicy: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* policy;
            if (current.version !== input.expectedVersion)
              return yield* new AllocationError({
                code: "conflict",
                detail: "Policy changed. Reload saved settings before saving.",
              });
            const next = {
              ...input.policy,
              ...(input.policy.accountWeights === undefined && current.accountWeights !== undefined
                ? { accountWeights: current.accountWeights }
                : {}),
              ...(input.policy.accountCaps === undefined && current.accountCaps !== undefined
                ? { accountCaps: current.accountCaps }
                : {}),
              version: current.version + 1,
            };
            const weights = next.accountWeights ?? [];
            if (
              new Set(weights.map((entry) => entry.key)).size !== weights.length ||
              weights.some(
                (entry) => !Number.isFinite(entry.weight) || entry.weight < 0 || entry.weight > 100,
              )
            )
              return yield* new AllocationError({
                code: "invalid",
                detail: "Account weights must be unique and between 0 and 100.",
              });
            const caps = next.accountCaps ?? [];
            if (
              new Set(caps.map((entry) => entry.key)).size !== caps.length ||
              caps.some(
                (entry) =>
                  (entry.weeklyPercent === null && entry.fiveHourPercent === null) ||
                  (entry.weeklyPercent !== null &&
                    (!Number.isFinite(entry.weeklyPercent) ||
                      entry.weeklyPercent < 0 ||
                      entry.weeklyPercent > 100)) ||
                  (entry.fiveHourPercent !== null &&
                    (!Number.isFinite(entry.fiveHourPercent) ||
                      entry.fiveHourPercent < 0 ||
                      entry.fiveHourPercent > 100)),
              )
            )
              return yield* new AllocationError({
                code: "invalid",
                detail:
                  "Account caps need unique identities, at least one threshold, and percentages from 0 to 100.",
              });
            if (next.defaultHours > next.maxForecastHours)
              return yield* new AllocationError({
                code: "invalid",
                detail: "Default duration must fit within the forecast horizon.",
              });
            for (const o of next.overrides) {
              if (o.expiresAt <= o.createdAt || (o.useBy && o.useBy <= o.createdAt))
                return yield* new AllocationError({
                  code: "invalid",
                  detail: "Override expiry and use-by target must follow its creation.",
                });
            }
            yield* sql`INSERT INTO provider_allocation_policy (id, version, policy_json) VALUES (1, ${next.version}, ${json(next)}) ON CONFLICT(id) DO UPDATE SET version = excluded.version, policy_json = excluded.policy_json`;
            return next;
          }),
        )
        .pipe(Effect.catchTag("SqlError", failure)),
    allocate,
    lifecycle: (input, at) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const r = yield* reservationById(input.assignmentId);
            if (
              !r ||
              r.request.environmentId !== input.environmentId ||
              r.request.threadId !== input.threadId
            )
              return yield* new AllocationError({
                code: "invalid",
                detail: "Reservation does not belong to this execution.",
              });
            if (
              input.action === "start" &&
              input.expectedRequest &&
              stableStringify(input.expectedRequest) !== stableStringify(r.request)
            )
              return yield* conflict(
                "The account choice changed before startup. Retry the chosen request; no start was committed.",
              );
            if (
              input.action === "start" &&
              input.startIntent &&
              r.startIntent === input.startIntent &&
              ["starting", "consumed"].includes(r.state)
            )
              return r;
            if (input.action === "start" && (r.state !== "reserved" || r.expiresAt <= at))
              return yield* new AllocationError({
                code: "conflict",
                detail: "Reservation cannot start with a different intent or after expiry.",
              });
            if (input.action === "consume" && !["starting", "consumed"].includes(r.state))
              return yield* new AllocationError({
                code: "conflict",
                detail: "Reservation was not started.",
              });
            if (input.action === "release" && r.state === "released") return r;
            const next: AllocationReservation = {
              ...r,
              ...(input.action === "start" && input.startIntent
                ? { startIntent: input.startIntent }
                : {}),
              state:
                input.action === "start"
                  ? "starting"
                  : input.action === "consume"
                    ? "consumed"
                    : "released",
            };
            yield* write(next);
            return next;
          }),
        )
        .pipe(Effect.catchTag("SqlError", failure)),
  });
});
export const layer = Layer.effect(AllocationStore, make);
