import {
  AllocationError,
  AllocationPolicy,
  AllocationReservation,
  AllocationDecision,
  defaultAllocationPolicy,
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
import { decideAllocation } from "./decision.ts";
import { stableStringify } from "@t3tools/shared/relaySigning";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const policyJson = Schema.decodeUnknownSync(Schema.fromJsonString(AllocationPolicy));
const reservationJson = Schema.decodeUnknownSync(Schema.fromJsonString(AllocationReservation));
const decisionJson = Schema.decodeUnknownSync(Schema.fromJsonString(AllocationDecision));
const failure = () =>
  new AllocationError({
    code: "persistence",
    detail: "Allocation state could not be read or committed.",
  });

export class AllocationStore extends Context.Service<
  AllocationStore,
  {
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
  return AllocationStore.of({
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
                detail: "Policy changed. Reload and preview before saving.",
              });
            const next = { ...input.policy, version: current.version + 1 };
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
    allocate: (input) =>
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
              if (stableStringify(prior.request) !== stableStringify(input.request))
                return yield* new AllocationError({
                  code: "conflict",
                  detail:
                    "Assignment ID already has different model, options, host or account constraints.",
                });
              if (prior.state === "expired" || prior.state === "released")
                return yield* new AllocationError({
                  code: "conflict",
                  detail: "Assignment is finished or expired. Use a new assignment ID.",
                });
              return { decision: prior.decision, reservation: prior, mode: current.mode };
            }
            if (
              input.reserve &&
              stored.some(
                (r) =>
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
            const last = (yield* history).find(
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
            if (input.reserve && current.mode === "automatic" && selected?.accountKey) {
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
        .pipe(Effect.catchTag("SqlError", failure)),
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
