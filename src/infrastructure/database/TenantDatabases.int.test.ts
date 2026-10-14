import { randomUUID } from "node:crypto";
import type { Container } from "inversify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TenantDatabaseMismatchError,
  TenantDatabaseUnavailableError,
  TenantSchemaOutdatedError,
} from "../../application/errors/TenantDatabaseErrors.js";
import type { ITenantDatabaseProvisioner } from "../../application/ports/ITenantDatabaseProvisioner.js";
import { TenantId } from "../../domain/value-objects/TenantId.js";
import { disposeContainer } from "../../framework/dependency-injection/container.js";
import { TYPES } from "../../framework/dependency-injection/types.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { TEST_DATABASE, testConfig } from "../../testing/testDatabase.js";
import { PgErrorCodes, pgErrorCode } from "./postgres/pgErrors.js";
import type {
  DatabaseRole,
  PostgresConnectionFactory,
} from "./postgres/PostgresConnectionFactory.js";
import {
  TenantConnectionPools,
  type TenantConnectionPoolsOptions,
} from "./postgres/TenantConnectionPools.js";
import type { TenantDatabaseNaming } from "./postgres/TenantDatabaseNaming.js";

const db = testConfig().database;
let container: Container;
let provisioner: ITenantDatabaseProvisioner;
let connections: PostgresConnectionFactory;
let naming: TenantDatabaseNaming;

const tenantA = TenantId.from(randomUUID());
const tenantB = TenantId.from(randomUUID());
const tenantC = TenantId.from(randomUUID());
const tenantD = TenantId.from(randomUUID());

const created: TenantConnectionPools[] = [];
function pools(overrides: Partial<TenantConnectionPoolsOptions> = {}): TenantConnectionPools {
  const instance = new TenantConnectionPools({
    clientConfigFor: (databaseName) => connections.clientConfig("tenant", databaseName),
    databaseNameFor: (tenantId) => naming.databaseNameFor(tenantId),
    maxPools: 10,
    maxConnectionsPerPool: 2,
    idleTimeoutMs: 5_000,
    statementTimeoutMs: 5_000,
    requiredSchemaVersion: "0001",
    ...overrides,
  });
  created.push(instance);
  return instance;
}

/** Connects as an app role to a database and reports the SQLSTATE of the failure, if any. */
async function connectErrorCode(role: DatabaseRole, database: string): Promise<string | undefined> {
  const client = new pg.Client(connections.clientConfig(role, database));
  try {
    await client.connect();
    return undefined;
  } catch (error) {
    return pgErrorCode(error);
  } finally {
    await client.end().catch(() => undefined);
  }
}

beforeAll(async () => {
  container = await createTestContainer();
  provisioner = container.get<ITenantDatabaseProvisioner>(TYPES.TenantDatabaseProvisioner);
  connections = container.get<PostgresConnectionFactory>(TYPES.PostgresConnectionFactory);
  naming = container.get<TenantDatabaseNaming>(TYPES.TenantDatabaseNaming);
  for (const tenant of [tenantA, tenantB, tenantC, tenantD]) {
    await provisioner.provision(tenant);
  }
});

afterAll(async () => {
  await Promise.all(created.map((p) => p.closeAll()));
  await disposeContainer(container);
});

describe("TenantDatabaseProvisioner", () => {
  it("creates a database named after the tenant id and stamps tenant_info", async () => {
    const tenant = TenantId.from(randomUUID());
    const result = await provisioner.provision(tenant);

    expect(result).toEqual({ databaseName: naming.databaseNameFor(tenant), created: true });
    expect(result.databaseName.startsWith(TEST_DATABASE.tenantPrefix)).toBe(true);
  });

  it("is idempotent", async () => {
    expect((await provisioner.provision(tenantA)).created).toBe(false);
  });

  it("clones the migrated template (schema version included)", async () => {
    const version = await pools().withTransaction(tenantA, async (tx) => {
      const { rows } = await tx.query<{ v: string }>(
        "select max(version) as v from schema_migrations",
      );
      return rows[0]?.v;
    });
    expect(version).toBe("0001");
  });
});

describe("TenantConnectionPools", () => {
  it("commits work done in withTransaction", async () => {
    const p = pools();
    await p.withTransaction(tenantA, (tx) =>
      tx.query("insert into counters (key, value) values ('commit-check', 7)"),
    );
    const { rows } = await p.withTransaction(tenantA, (tx) =>
      tx.query<{ value: string }>("select value::text from counters where key = 'commit-check'"),
    );
    expect(rows[0]?.value).toBe("7");
  });

  it("rolls back when the callback throws", async () => {
    const p = pools();
    await expect(
      p.withTransaction(tenantA, async (tx) => {
        await tx.query("insert into counters (key, value) values ('rollback-check', 1)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const { rows } = await p.withTransaction(tenantA, (tx) =>
      tx.query("select 1 from counters where key = 'rollback-check'"),
    );
    expect(rows).toHaveLength(0);
  });

  it("keeps tenants' data apart", async () => {
    const p = pools();
    await p.withTransaction(tenantB, (tx) =>
      tx.query("insert into counters (key, value) values ('only-in-b', 1)"),
    );
    const inA = await p.withTransaction(tenantA, (tx) =>
      tx.query("select 1 from counters where key = 'only-in-b'"),
    );
    expect(inA.rows).toHaveLength(0);
  });

  it("refuses a database that belongs to another tenant", async () => {
    // Misroute tenant B to tenant A's database: the tenant_info check must catch it.
    const p = pools({ databaseNameFor: () => naming.databaseNameFor(tenantA) });
    await expect(p.withTransaction(tenantB, (tx) => tx.query("select 1"))).rejects.toBeInstanceOf(
      TenantDatabaseMismatchError,
    );
    expect(p.stats().openPools).toBe(0);
  });

  it("refuses a database below the required schema version", async () => {
    const p = pools({ requiredSchemaVersion: "9999" });
    await expect(p.withTransaction(tenantA, (tx) => tx.query("select 1"))).rejects.toBeInstanceOf(
      TenantSchemaOutdatedError,
    );
  });

  it("reports a missing database as unavailable", async () => {
    await expect(
      pools().withTransaction(TenantId.from(randomUUID()), (tx) => tx.query("select 1")),
    ).rejects.toBeInstanceOf(TenantDatabaseUnavailableError);
  });

  it("opens a single pool for concurrent first requests", async () => {
    const p = pools();
    await Promise.all(
      Array.from({ length: 20 }, () => p.withTransaction(tenantC, (tx) => tx.query("select 1"))),
    );
    expect(p.stats().openPools).toBe(1);
    expect(p.stats().totalConnections).toBeLessThanOrEqual(2);
  });

  it("closes least recently used pools beyond the limit and reopens them on demand", async () => {
    const p = pools({ maxPools: 2 });
    for (const tenant of [tenantA, tenantB, tenantC, tenantD]) {
      await p.withTransaction(tenant, (tx) => tx.query("select 1"));
    }
    expect(p.stats().openPools).toBe(2);

    const { rows } = await p.withTransaction(tenantA, (tx) => tx.query("select 1 as ok"));
    expect(rows).toEqual([{ ok: 1 }]);
    expect(p.stats().openPools).toBe(2);
  });

  it("applies transaction-local settings and the statement timeout", async () => {
    const p = pools();
    const userId = randomUUID();
    const seen = await p.withTransaction(
      tenantA,
      async (tx) => {
        const { rows } = await tx.query<{ v: string }>(
          "select current_setting('app.user_id') as v",
        );
        return rows[0]?.v;
      },
      { settings: { "app.user_id": userId } },
    );
    expect(seen).toBe(userId);

    await expect(
      p.withTransaction(tenantA, (tx) => tx.query("select pg_sleep(2)"), {
        statementTimeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: PgErrorCodes.queryCanceled });
  });

  it("rejects invalid transaction setting names", async () => {
    await expect(
      pools().withTransaction(tenantA, (tx) => tx.query("select 1"), {
        settings: { search_path: "evil" },
      }),
    ).rejects.toThrow(/Invalid transaction setting name/);
  });
});

describe("database roles and grants", () => {
  it("the tenant app role cannot change tenant identity, run DDL or rewrite audit history", async () => {
    const p = pools();
    const attempt = (sql: string) =>
      p
        .withTransaction(tenantA, (tx) => tx.query(sql))
        .then(
          () => undefined,
          (error: unknown) => pgErrorCode(error),
        );

    await p.withTransaction(tenantA, (tx) =>
      tx.query(
        "insert into audit_logs (actor_type, action, entity_type) values ('system', 'test.created', 'test')",
      ),
    );

    expect(await attempt(`update tenant_info set tenant_id = '${tenantB.value}'`)).toBe(
      PgErrorCodes.insufficientPrivilege,
    );
    expect(await attempt("insert into schema_migrations values ('9999','x','x',now(),0)")).toBe(
      PgErrorCodes.insufficientPrivilege,
    );
    expect(await attempt("create table sneaky (id int)")).toBe(PgErrorCodes.insufficientPrivilege);
    expect(await attempt("update audit_logs set action = 'test.changed'")).toBe(
      PgErrorCodes.insufficientPrivilege,
    );
    expect(await attempt("delete from audit_logs")).toBe(PgErrorCodes.insufficientPrivilege);
  });

  it("the tenant app role can only connect to tenant databases", async () => {
    expect(await connectErrorCode("tenant", naming.databaseNameFor(tenantA))).toBeUndefined();
    expect(await connectErrorCode("tenant", db.platformDatabase)).toBe(
      PgErrorCodes.insufficientPrivilege,
    );
    expect(await connectErrorCode("tenant", db.tenantTemplateDatabase)).toBe(
      PgErrorCodes.insufficientPrivilege,
    );
  });

  it("the platform app role can only connect to the platform database", async () => {
    expect(await connectErrorCode("platform", db.platformDatabase)).toBeUndefined();
    expect(await connectErrorCode("platform", naming.databaseNameFor(tenantA))).toBe(
      PgErrorCodes.insufficientPrivilege,
    );
  });
});
