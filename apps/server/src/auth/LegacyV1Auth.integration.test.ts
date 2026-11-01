import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { initializeV2Database } from "../persistence/initializeV2Database.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as SessionStore from "./SessionStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

it.effect("paired V1 cookie and bearer survive the actual database import and V2 restart", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const sourcePath = path.join(path.dirname(config.dbPath), "state.sqlite");
    yield* fs.makeDirectory(path.dirname(sourcePath), { recursive: true });
    const source = NodeSqliteClient.layer({ filename: sourcePath });
    yield* runMigrations({ toMigrationInclusive: 54 }).pipe(Effect.provide(source));
    const authLayer = <E, R>(db: Layer.Layer<SqlClient.SqlClient, E, R>) =>
      EnvironmentAuth.layer.pipe(
        Layer.provideMerge(SessionStore.layer),
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provide(ServerEnvironment.layerIdentity),
        Layer.provide(db),
      );
    // Both runtimes issue v:1 session claims and use the same persisted pairing/session schema.
    const paired = yield* Effect.scoped(
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const cookieGrant = yield* auth.issuePairingCredential();
        const cookie = yield* auth.createBrowserSession(cookieGrant.credential, {
          label: "V1 browser",
          deviceType: "desktop",
        });
        const tokenGrant = yield* auth.issuePairingCredential();
        const bearer = yield* auth.exchangeBootstrapCredentialForAccessToken(
          tokenGrant.credential,
          undefined,
          { label: "V1 mobile", deviceType: "mobile" },
        );
        const cookieSession = yield* sessions.verify(cookie.sessionToken);
        const bearerSession = yield* sessions.verify(bearer.access_token);
        return {
          cookie,
          bearer,
          cookieName: sessions.cookieName,
          cookieId: cookieSession.sessionId,
          bearerId: bearerSession.sessionId,
        };
      }).pipe(Effect.provide(authLayer(source))),
    );
    yield* initializeV2Database(config.dbPath);
    const migrated = Sqlite.layerFromPath(config.dbPath);
    for (let restart = 0; restart < 2; restart++) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const auth = yield* EnvironmentAuth.EnvironmentAuth;
          const sessions = yield* SessionStore.SessionStore;
          assert.equal(sessions.cookieName, paired.cookieName);
          type Request = Parameters<typeof auth.authenticateHttpRequest>[0];
          const cookie = yield* auth.authenticateHttpRequest({
            cookies: { [paired.cookieName]: paired.cookie.sessionToken },
            headers: {},
          } as unknown as Request);
          const bearer = yield* auth.authenticateHttpRequest({
            cookies: {},
            headers: { authorization: `Bearer ${paired.bearer.access_token}` },
          } as unknown as Request);
          assert.equal(cookie.sessionId, paired.cookieId);
          assert.equal(bearer.sessionId, paired.bearerId);
          const ticket = yield* sessions.issueWebSocketToken(paired.bearerId);
          assert.equal(
            (yield* sessions.verifyWebSocketToken(ticket.token)).sessionId,
            paired.bearerId,
          );
        }).pipe(Effect.provide(Layer.fresh(authLayer(migrated)))),
      );
    }
    const oldHead = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return (yield* sql<{
        id: number;
      }>`SELECT MAX(migration_id) AS id FROM effect_sql_migrations`)[0]?.id;
    }).pipe(Effect.provide(source));
    assert.equal(oldHead, 54);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "v1-v2-auth-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
