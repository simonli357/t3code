import { expect, it } from "@effect/vitest";
import {
  defaultAllocationPolicy,
  ServerProvider,
  type AllocationResponse,
  type ComputerCapacity,
  type UsageMeasurementsReport,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as Computers from "../computers/Computers.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as Peers from "../orchestration/PeerLinks.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import { UsageMeasurements } from "../usage/UsageMeasurements.ts";
import * as Store from "./AllocationStore.ts";
import * as Allocation from "./ProviderAllocation.ts";

/**
 * Several servers wired together through the real peer client (its real call deadline), a fake HTTP
 * layer standing in for the network, and one virtual clock. Every server links the others. A master
 * reads its own computer and the linked ones itself, whichever server is the allocation coordinator.
 */
const GIB = 2 ** 30;
const report: UsageMeasurementsReport = {
  observedAt: "1970-01-01T00:00:00.000Z",
  monitoredInstanceIds: [],
  retentionDays: 14,
  persistenceError: null,
  accounts: [],
  turns: [],
  totalMatchingTurns: 0,
  profiles: [],
  limitations: [],
};
const provider = Schema.decodeUnknownSync(ServerProvider)({
  instanceId: "chosen",
  driver: "codex",
  displayName: "chosen",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated", email: "account@example.test" },
  checkedAt: "1970-01-01T00:00:00.000Z",
  models: [
    { slug: "astra", name: "Astra", isCustom: false, capabilities: { optionDescriptors: [] } },
  ],
});

/** What the network does with a request for a computer. */
type Delivery =
  | "prompt"
  | "never"
  | "refuse"
  | { readonly after: number }
  | { readonly reject: string }
  /** An older server: it serves inventory reads but refuses allocation operations it predates. */
  | "older";

interface ServerSpec {
  readonly id: string;
  readonly label: string;
  /** The allocation coordinator this server uses (its own ID when it is the coordinator). */
  readonly coordinator: string;
  readonly peers: ReadonlyArray<{ readonly environmentId: string; readonly label: string }>;
  /** How long this computer takes to take its own reading (the host sample alone takes 200 ms); `"never"` hangs it. */
  readonly reading?: number | "never";
}

const buildServer = (
  spec: ServerSpec,
  deliver: (target: string, from: string, request: unknown) => Effect.Effect<unknown, Error>,
) =>
  Effect.gen(function* () {
    const configured = new TextEncoder().encode(
      JSON.stringify({
        peers: spec.peers.map((peer) => ({
          ...peer,
          url: `http://${peer.environmentId}/`,
          token: "t",
        })),
      }),
    );
    const network = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(
        (request) =>
          Effect.gen(function* () {
            const target = new URL(request.url).hostname;
            const sent = JSON.parse(
              new TextDecoder().decode((request.body as { body: Uint8Array }).body),
            ) as { from: string; request: unknown };
            // Every hop of the network takes a moment; a reply never arrives at the instant a deadline does.
            yield* Effect.sleep(10);
            const answer = yield* deliver(target, sent.from, sent.request);
            const refused =
              typeof answer === "object" && answer !== null && "rejected" in answer
                ? String(answer.rejected)
                : undefined;
            return HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify(refused === undefined ? answer : { message: refused }), {
                status: refused === undefined ? 200 : 409,
                headers: { "content-type": "application/json" },
              }),
            );
          }) as never,
      ),
    );
    const reading = Effect.gen(function* () {
      if (spec.reading === "never") return yield* Effect.never;
      yield* Effect.sleep(spec.reading ?? 200);
      const sampledAt = yield* Clock.currentTimeMillis;
      return {
        sampledAt,
        os: "linux",
        resources: {
          sampledAt,
          cpuUtilization: 0.25,
          cpuCount: 16,
          availableMemoryBytes: 10 * GIB,
          totalMemoryBytes: 16 * GIB,
        },
        disks: [],
        workDisk: null,
        jobs: null,
        notices: [],
      } satisfies ComputerCapacity;
    });
    const deps = Layer.mergeAll(
      NodeSqliteClient.layer({ filename: ":memory:" }),
      Settings.layerTest({ allocationCoordinatorEnvironmentId: spec.coordinator }),
      Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 0,
            projects: [],
            threads: [],
            updatedAt: "1970-01-01T00:00:00.000Z",
          }),
        getThreadShellById: () => Effect.succeed(Option.none()),
      }),
      Layer.succeed(UsageMeasurements, { read: () => Effect.succeed(report) }),
      Layer.mock(Computers.Computers)({ capacity: () => reading }),
      Peers.layer.pipe(
        Layer.provide(
          Layer.mock(ServerSecretStore)({ get: () => Effect.succeed(Option.some(configured)) }),
        ),
        Layer.provide(
          Layer.mock(ServerEnvironment)({
            getDescriptor: Effect.succeed({ environmentId: spec.id, label: spec.label } as never),
          }),
        ),
        Layer.provide(network),
      ),
    );
    const context = yield* Layer.build(
      Allocation.layer.pipe(Layer.provideMerge(Store.layer), Layer.provideMerge(deps)),
    );
    yield* Effect.gen(function* () {
      yield* runMigrations();
      const store = yield* Store.AllocationStore;
      yield* store.savePolicy({
        expectedVersion: 0,
        policy: { ...defaultAllocationPolicy, coordinatorEnvironmentId: spec.coordinator },
      });
    }).pipe(Effect.provide(context));
    return Context.get(context, Allocation.ProviderAllocation);
  });

/** The master's server (`source`), the allocation coordinator (`coord`) and a third computer. */
const topology = (options: {
  readonly third?: Delivery;
  readonly coordinator?: Delivery;
  readonly coordinatorReading?: ServerSpec["reading"];
  readonly thirdReading?: ServerSpec["reading"];
}) =>
  Effect.gen(function* () {
    const servers: Record<string, Allocation.ProviderAllocation["Service"]> = {};
    const behaviour: Record<string, Delivery> = {
      third: options.third ?? "prompt",
      coord: options.coordinator ?? "prompt",
    };
    const deliver = (
      target: string,
      from: string,
      request: unknown,
    ): Effect.Effect<unknown, Error> => {
      const how = behaviour[target] ?? "prompt";
      // The peer route answers a refused request with 409 and its message.
      const reach = Effect.suspend(() => servers[target]!.receive(from, request)).pipe(
        Effect.catch((error) => Effect.succeed({ rejected: error.message })),
      );
      if (how === "never") return Effect.never;
      if (how === "refuse") return Effect.fail(new Error("connection refused"));
      if (how === "prompt") return reach;
      if (how === "older")
        return typeof request === "object" &&
          request !== null &&
          (request as { _tag?: unknown })._tag === "allocation"
          ? Effect.succeed({ rejected: "Invalid allocation peer request." })
          : reach;
      if ("reject" in how) return Effect.succeed({ rejected: how.reject });
      return Effect.sleep(how.after).pipe(Effect.andThen(reach));
    };
    const link = (id: string, label: string) => ({ environmentId: id, label });
    servers.coord = yield* buildServer(
      {
        id: "coord",
        label: "Coord",
        coordinator: "coord",
        peers: [link("source", "Source"), link("third", "Third")],
        ...(options.coordinatorReading === undefined
          ? {}
          : { reading: options.coordinatorReading }),
      },
      deliver,
    );
    servers.source = yield* buildServer(
      {
        id: "source",
        label: "Source",
        coordinator: "coord",
        peers: [link("coord", "Coord"), link("third", "Third")],
      },
      deliver,
    );
    servers.third = yield* buildServer(
      {
        id: "third",
        label: "Third",
        coordinator: "coord",
        peers: [link("coord", "Coord"), link("source", "Source")],
        ...(options.thirdReading === undefined ? {} : { reading: options.thirdReading }),
      },
      deliver,
    );
    return servers as Record<
      "coord" | "source" | "third",
      Allocation.ProviderAllocation["Service"]
    >;
  });

/** Runs an operation on the virtual clock until it settles; how long that took, in seconds. */
const settle = <A, E>(fiber: Fiber.Fiber<A, E>, limitSeconds = 120) =>
  Effect.gen(function* () {
    yield* TestClock.adjust("0 millis");
    for (let tenths = 0; tenths <= limitSeconds * 10; tenths++) {
      const exit = fiber.pollUnsafe();
      if (exit) return { seconds: tenths / 10, exit };
      yield* TestClock.adjust("100 millis");
    }
    return yield* Effect.die(new Error(`still running after ${limitSeconds} virtual seconds`));
  });

const advice = (
  server: Allocation.ProviderAllocation["Service"],
  request: Parameters<Allocation.ProviderAllocation["Service"]["execute"]>[0] = {
    _tag: "placement",
    request: {},
  },
) =>
  Effect.gen(function* () {
    const fiber = yield* server.execute(request).pipe(Effect.forkChild);
    const { seconds, exit } = yield* settle(fiber);
    return { seconds, exit };
  });
const hostsOf = (exit: Exit.Exit<AllocationResponse, unknown>) =>
  Exit.isSuccess(exit)
    ? (exit.value.placement?.hosts.map((host) => [host.label, host.state] as const) ?? [])
    : [];
const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "";

it.effect("control: every computer answers promptly for a master away from the coordinator", () =>
  Effect.gen(function* () {
    const { source } = yield* topology({});
    const { seconds, exit } = yield* advice(source);
    expect(seconds).toBeLessThan(1);
    expect(hostsOf(exit).toSorted()).toEqual([
      ["Coord", "fresh"],
      ["Source", "fresh"],
      ["Third", "fresh"],
    ]);
  }).pipe(Effect.scoped),
);

it.effect(
  "a master on the coordinator sees an unresponsive computer as offline after one peer deadline",
  () =>
    Effect.gen(function* () {
      const { coord } = yield* topology({ third: "never" });
      const { seconds, exit } = yield* advice(coord);
      expect(seconds).toBeGreaterThanOrEqual(15);
      expect(seconds).toBeLessThan(16);
      expect(hostsOf(exit)).toContainEqual(["Third", "offline"]);
      expect(hostsOf(exit)).toContainEqual(["Coord", "fresh"]);
    }).pipe(Effect.scoped),
);

it.effect(
  "a master away from the coordinator still gets the advice when a computer never answers",
  () =>
    Effect.gen(function* () {
      const { source } = yield* topology({ third: "never" });
      const { seconds, exit } = yield* advice(source);
      expect(failureOf(exit)).toBe("");
      // The coordinator gives up on the silent computer after one peer deadline and answers; the
      // master's wait around that is longer, so it never reports the coordinator as unreachable.
      expect(seconds).toBeGreaterThanOrEqual(15);
      expect(seconds).toBeLessThan(16);
      expect(hostsOf(exit).toSorted()).toEqual([
        ["Coord", "fresh"],
        ["Source", "fresh"],
        ["Third", "offline"],
      ]);
    }).pipe(Effect.scoped),
);

it.effect("a slow computer is read while the coordinator takes its own reading, not after it", () =>
  Effect.gen(function* () {
    // 4 s of its own reading and a computer that answers after 12 s need 16 s one after the other,
    // which no 15 s wait survives; together they need 12 s.
    const { source } = yield* topology({ third: { after: 12_000 }, coordinatorReading: 4_000 });
    const { seconds, exit } = yield* advice(source);
    expect(failureOf(exit)).toBe("");
    expect(seconds).toBeGreaterThanOrEqual(12);
    expect(seconds).toBeLessThan(13);
    expect(hostsOf(exit).toSorted()).toEqual([
      ["Coord", "fresh"],
      ["Source", "fresh"],
      ["Third", "fresh"],
    ]);
  }).pipe(Effect.scoped),
);

it.effect("a reading that never finishes leaves its computer unknown and delays no other", () =>
  Effect.gen(function* () {
    const { coord } = yield* topology({ coordinatorReading: "never", third: "never" });
    const { seconds, exit } = yield* advice(coord);
    expect(failureOf(exit)).toBe("");
    expect(seconds).toBeGreaterThanOrEqual(15);
    expect(seconds).toBeLessThan(16);
    expect(hostsOf(exit).toSorted()).toEqual([
      ["Coord", "unknown"],
      ["Source", "fresh"],
      ["Third", "offline"],
    ]);
  }).pipe(Effect.scoped),
);

it.effect("a computer named by the user stays the answer when it never answers", () =>
  Effect.gen(function* () {
    const { source } = yield* topology({ third: "never" });
    const { exit } = yield* advice(source, {
      _tag: "placement",
      request: { environmentId: "third" },
    });
    expect(Exit.isSuccess(exit) && exit.value.placement?.recommendedEnvironmentId).toBe("third");
    expect(hostsOf(exit)).toContainEqual(["Third", "offline"]);
  }).pipe(Effect.scoped),
);

it.effect(
  "an older coordinator cannot fail the advice; a failing computer shows its own error",
  () =>
    Effect.gen(function* () {
      // The coordinator predates placement and refuses it; the master never asks it to place.
      const older = yield* topology({ coordinator: "older" });
      const kept = yield* advice(older.source);
      expect(failureOf(kept.exit)).toBe("");
      expect(hostsOf(kept.exit).toSorted()).toEqual([
        ["Coord", "fresh"],
        ["Source", "fresh"],
        ["Third", "fresh"],
      ]);

      const broken = yield* topology({ coordinator: "older", third: "refuse" });
      const { exit } = yield* advice(broken.source);
      expect(failureOf(exit)).toBe("");
      const placement = Exit.isSuccess(exit) ? exit.value.placement! : undefined;
      const third = placement?.hosts.find((host) => host.label === "Third");
      expect(third?.state).toBe("offline");
      expect(third?.warnings.join(" ")).toContain("connection refused");
      expect(
        placement?.hosts.filter((host) => host.state === "fresh").map((host) => host.label),
      ).toEqual(expect.arrayContaining(["Coord", "Source"]));
      expect(placement?.recommendedEnvironmentId).not.toBe("third");
    }).pipe(Effect.scoped),
);

it.effect("ordinary previews keep the single peer deadline", () =>
  Effect.gen(function* () {
    const { source } = yield* topology({ coordinator: "never" });
    const { seconds, exit } = yield* advice(source, {
      _tag: "preview",
      request: {
        assignmentId: "assignment",
        environmentId: "coord",
        threadId: "thread" as never,
        driver: "codex" as never,
        model: "astra",
        options: [],
      },
    });
    expect(seconds).toBe(15);
    expect(failureOf(exit)).toContain(
      "Allocation authority or execution environment is unavailable",
    );
  }).pipe(Effect.scoped),
);
