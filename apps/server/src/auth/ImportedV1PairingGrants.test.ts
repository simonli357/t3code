import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";

const importedDatabase = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 52 });
    for (const id of ["operate", "read", "expired", "revoked", "spent"]) {
      yield* sql`INSERT INTO auth_pairing_links
        (id, credential, method, scopes, subject, label, proof_key_thumbprint,
         created_at, expires_at, consumed_at, revoked_at)
        VALUES (${id}, ${`unchanged-${id}`}, 'one-time-token',
          ${JSON.stringify([id === "read" ? "orchestration:read" : "orchestration:operate"])},
          'one-time-token', 'Retained V1 link', 'bound-key', '2020-01-01T00:00:00.000Z',
          ${id === "expired" ? "1960-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z"},
          ${id === "spent" ? "2021-01-01T00:00:00.000Z" : null},
          ${id === "revoked" ? "2021-01-01T00:00:00.000Z" : null})`;
    }
    const before = yield* sql`SELECT * FROM auth_pairing_links ORDER BY id`;
    yield* runMigrations();
    const after = yield* sql`SELECT * FROM auth_pairing_links ORDER BY id`;
    const withoutScopes = (rows: typeof before) => rows.map(({ scopes: _, ...row }) => row);
    expect(withoutScopes(after)).toEqual(withoutScopes(before));
  }),
).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));
const layer = PairingGrantStore.layer.pipe(
  Layer.provide(importedDatabase),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-imported-pairing-" })),
);

it.layer(NodeServices.layer)("Imported V1 pairing links", (it) => {
  it.effect("redeems equivalent granular scopes after failed scope and proof requests", () =>
    Effect.gen(function* () {
      const store = yield* PairingGrantStore.PairingGrantStore;
      for (const input of [
        { requestedScopes: ["settings:write"] as const },
        { proofKeyThumbprint: "wrong-key", requestedScopes: ["settings:write"] as const },
        { proofKeyThumbprint: "bound-key", requestedScopes: ["access:write"] as const },
        { proofKeyThumbprint: "bound-key", requestedScopes: ["terminal:operate"] as const },
      ]) {
        yield* Effect.flip(store.consume("unchanged-operate", input));
      }
      const grant = yield* store.consume("unchanged-operate", {
        proofKeyThumbprint: "bound-key",
        requestedScopes: ["settings:write"],
      });
      expect(grant.scopes).toContain("settings:write");
      expect(grant.scopes).toContain("providers:manage");
      expect(grant.scopes).not.toContain("access:write");
      expect(grant.scopes).not.toContain("terminal:operate");
      expect(grant.proofKeyThumbprint).toBe("bound-key");
      expect(grant.label).toBe("Retained V1 link");
      yield* Effect.flip(store.consume("unchanged-operate", { proofKeyThumbprint: "bound-key" }));
    }).pipe(Effect.provide(layer)),
  );
  it.effect(
    "preserves read-only authority and returns expanded scopes without a scope request",
    () =>
      Effect.gen(function* () {
        const store = yield* PairingGrantStore.PairingGrantStore;
        for (const scope of [
          "settings:write",
          "filesystem:write",
          "access:write",
          "terminal:read",
        ] as const) {
          yield* Effect.flip(
            store.consume("unchanged-read", {
              proofKeyThumbprint: "bound-key",
              requestedScopes: [scope],
            }),
          );
        }
        const grant = yield* store.consume("unchanged-read", { proofKeyThumbprint: "bound-key" });
        expect(grant.scopes).toEqual(["orchestration:read", "filesystem:read", "diagnostics:read"]);
      }).pipe(Effect.provide(layer)),
  );
  it.effect("keeps expired, revoked and consumed links unusable", () =>
    Effect.gen(function* () {
      const store = yield* PairingGrantStore.PairingGrantStore;
      for (const id of ["expired", "revoked", "spent"]) {
        yield* Effect.flip(
          store.consume(`unchanged-${id}`, {
            proofKeyThumbprint: "bound-key",
            requestedScopes: ["settings:write"],
          }),
        );
      }
    }).pipe(Effect.provide(layer)),
  );
  it.effect("leaves new V2 grants literal and retains them after a rejected request", () =>
    Effect.gen(function* () {
      const store = yield* PairingGrantStore.PairingGrantStore;
      const issued = yield* store.issueOneTimeToken({ scopes: ["orchestration:operate"] });
      yield* Effect.flip(store.consume(issued.credential, { requestedScopes: ["settings:write"] }));
      const grant = yield* store.consume(issued.credential);
      expect(grant.scopes).toEqual(["orchestration:operate"]);
    }).pipe(Effect.provide(layer)),
  );
});
