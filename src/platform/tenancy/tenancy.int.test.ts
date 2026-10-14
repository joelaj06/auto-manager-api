import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseServices } from "../../testing/test-services.js";
import { clientConfig, connectionSettings } from "../../shared/db/connection.js";
import {
  PgErrorCodes,
  pgErrorCode,
  TenantDatabaseMismatchError,
  TenantDatabaseUnavailableError,
  TenantSchemaOutdatedError,
} from "../../shared/db/errors.js";
import { InvalidTenantIdError } from "../../shared/db/naming.js";
import { TenantPoolManager } from "../../shared/db/tenant-pools.js";
import { TEST_DATABASE, testConfig } from "../../testing/test-database.js";

const config = testConfig();
const services = testDatabaseServices();
const db = config.database;

const tenantA = randomUUID();
const tenantB = randomUUID();
const tenantC = randomUUID();
const tenantD = randomUUID();

const managers: TenantPoolManager[] = [];
function poolManager(
  overrides: Partial<ConstructorParameters<typeof TenantPoolManager>[0]> = {},
): TenantPoolManager {
  const { database: _unused, ...connection } = connectionSettings(db, db.roles.tenant, "");
  const manager = new TenantPoolManager({
    connection,
    databaseNameFor: services.databaseNameFor,
    maxPools: 10,
    maxConnectionsPerPool: 2,
    idleTimeoutMs: 5_000,
    statementTimeoutMs: 5_000,
    requiredSchemaVersion: "0001",
    ...overrides,
  });
  managers.push(manager);
  return manager;
}

/** Connects as a given app role to a database and reports the SQLSTATE of the failure, if any. */
async function connectErrorCode(
  role: { user: string; password: string },
  database: string,
): Promise<string | undefined> {
  const client = new pg.Client(clientConfig(connectionSettings(db, role, database)));
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
  for (const tenant of [tenantA, tenantB, tenantC, tenantD]) {
    await services.tenantDatabaseFactory.create(tenant);
  }
});

afterAll(async () => {
  await Promise.all(managers.map((m) => m.closeAll()));
});

describe("TenantDatabaseFactory", () => {
  it("creates a database named after the tenant id and stamps tenant_info", async () => {
    const tenant = randomUUID();
    const result = await services.tenantDatabaseFactory.create(tenant);

    expect(result).toEqual({ databaseName: services.databaseNameFor(tenant), created: true });
    expect(result.databaseName.startsWith(TEST_DATABASE.tenantPrefix)).toBe(true);
  });

  it("is idempotent", async () => {
    const again = await services.tenantDatabaseFactory.create(tenantA);
    expect(again.created).toBe(false);
  });

  it("clones the migrated template (schema version included)", async () => {
    const version = await poolManager().withTransaction(tenantA, async (tx) => {
      const { rows } = await tx.query<{ v: string }>(
        "select max(version) as v from schema_migrations",
      );
      return rows[0]?.v;
    });
    expect(version).toBe("0001");
  });
});

describe("TenantPoolManager", () => {
  it("commits work done in withTransaction", async () => {
    const pools = poolManager();
    await pools.withTransaction(tenantA, (tx) =>
      tx.query("insert into counters (key, value) values ('commit-check', 7)"),
    );
    const value = await pools.withTransaction(tenantA, async (tx) => {
      const { rows } = await tx.query<{ value: string }>(
        "select value::text from counters where key = 'commit-check'",
      );
      return rows[0]?.value;
    });
    expect(value).toBe("7");
  });

  it("rolls back when the callback throws", async () => {
    const pools = poolManager();
    await expect(
      pools.withTransaction(tenantA, async (tx) => {
        await tx.query("insert into counters (key, value) values ('rollback-check', 1)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const { rows } = await pools.withTransaction(tenantA, (tx) =>
      tx.query("select 1 from counters where key = 'rollback-check'"),
    );
    expect(rows).toHaveLength(0);
  });

  it("keeps tenants' data apart", async () => {
    const pools = poolManager();
    await pools.withTransaction(tenantB, (tx) =>
      tx.query("insert into counters (key, value) values ('only-in-b', 1)"),
    );
    const inA = await pools.withTransaction(tenantA, (tx) =>
      tx.query("select 1 from counters where key = 'only-in-b'"),
    );
    expect(inA.rows).toHaveLength(0);
  });

  it("refuses a database that belongs to another tenant", async () => {
    // Misroute tenant B to tenant A's database: the tenant_info check must catch it.
    const pools = poolManager({ databaseNameFor: () => services.databaseNameFor(tenantA) });
    await expect(
      pools.withTransaction(tenantB, (tx) => tx.query("select 1")),
    ).rejects.toBeInstanceOf(TenantDatabaseMismatchError);
    expect(pools.stats().openPools).toBe(0);
  });

  it("refuses a database below the required schema version", async () => {
    const pools = poolManager({ requiredSchemaVersion: "9999" });
    await expect(
      pools.withTransaction(tenantA, (tx) => tx.query("select 1")),
    ).rejects.toBeInstanceOf(TenantSchemaOutdatedError);
  });

  it("reports a missing database as unavailable", async () => {
    await expect(
      poolManager().withTransaction(randomUUID(), (tx) => tx.query("select 1")),
    ).rejects.toBeInstanceOf(TenantDatabaseUnavailableError);
  });

  it("rejects ids that are not UUIDs", async () => {
    await expect(
      poolManager().withTransaction("../etc", (tx) => tx.query("select 1")),
    ).rejects.toBeInstanceOf(InvalidTenantIdError);
  });

  it("opens a single pool for concurrent first requests", async () => {
    const pools = poolManager();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        pools.withTransaction(tenantC, (tx) => tx.query("select 1")),
      ),
    );
    expect(pools.stats().openPools).toBe(1);
    expect(pools.stats().totalConnections).toBeLessThanOrEqual(2);
  });

  it("closes least recently used pools beyond the limit and reopens them on demand", async () => {
    const pools = poolManager({ maxPools: 2 });
    for (const tenant of [tenantA, tenantB, tenantC, tenantD]) {
      await pools.withTransaction(tenant, (tx) => tx.query("select 1"));
    }
    expect(pools.stats().openPools).toBe(2);

    const { rows } = await pools.withTransaction(tenantA, (tx) => tx.query("select 1 as ok"));
    expect(rows).toEqual([{ ok: 1 }]);
    expect(pools.stats().openPools).toBe(2);
  });

  it("applies transaction-local settings and the statement timeout", async () => {
    const pools = poolManager();
    const userId = randomUUID();
    const seen = await pools.withTransaction(
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
      pools.withTransaction(tenantA, (tx) => tx.query("select pg_sleep(2)"), {
        statementTimeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "57014" });
  });

  it("rejects invalid transaction setting names", async () => {
    await expect(
      poolManager().withTransaction(tenantA, (tx) => tx.query("select 1"), {
        settings: { search_path: "evil" },
      }),
    ).rejects.toThrow(/Invalid transaction setting name/);
  });
});

describe("database roles and grants", () => {
  it("the tenant app role cannot change tenant identity, run DDL or rewrite audit history", async () => {
    const pools = poolManager();
    const attempt = (sql: string) =>
      pools
        .withTransaction(tenantA, (tx) => tx.query(sql))
        .then(
          () => undefined,
          (error: unknown) => pgErrorCode(error),
        );

    await pools.withTransaction(tenantA, (tx) =>
      tx.query(
        "insert into audit_logs (actor_type, action, entity_type) values ('system', 'test.created', 'test')",
      ),
    );

    expect(await attempt(`update tenant_info set tenant_id = '${tenantB}'`)).toBe(
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
    const tenantRole = db.roles.tenant;
    expect(await connectErrorCode(tenantRole, services.databaseNameFor(tenantA))).toBeUndefined();
    expect(await connectErrorCode(tenantRole, db.platformDatabase)).toBe(
      PgErrorCodes.insufficientPrivilege,
    );
    expect(await connectErrorCode(tenantRole, db.tenantTemplateDatabase)).toBe(
      PgErrorCodes.insufficientPrivilege,
    );
  });

  it("the platform app role can only connect to the platform database", async () => {
    const platformRole = db.roles.platform;
    expect(await connectErrorCode(platformRole, db.platformDatabase)).toBeUndefined();
    expect(await connectErrorCode(platformRole, services.databaseNameFor(tenantA))).toBe(
      PgErrorCodes.insufficientPrivilege,
    );
  });
});
