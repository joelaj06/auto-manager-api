import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PermissionGrants } from "../../application/authorization/Principal.js";
import type { IPermissionResolver } from "../../application/ports/IPermissionResolver.js";
import { disposeContainer } from "../../framework/dependency-injection/container.js";
import { TYPES } from "../../framework/dependency-injection/types.js";
import type { PostgresConnectionFactory } from "../../infrastructure/database/postgres/PostgresConnectionFactory.js";
import { TenantFixtures, type TestTenant } from "../fixtures/TenantFixtures.js";
import { createTestContainer } from "../testContainer.js";
import { TEST_DATABASE, testConfig } from "../testDatabase.js";
import {
  APPEND_ONLY_TENANT_TABLES,
  TENANT_TABLE_EXEMPTIONS,
  TENANT_TABLE_FIXTURES,
} from "./tenantTableFixtures.js";

/**
 * Generated tenant-isolation suite (docs/04 §13, docs/22 §2.4): runs over every table of the
 * tenant schema, discovered from the migrated template, so new tables are covered automatically
 * — or fail until a fixture is added.
 */
let container: Container;
let tenantA: TestTenant;
let tenantB: TestTenant;
let tenantTables: string[];
let platformTables: string[];

async function tablesOf(role: "migrator", database: string): Promise<string[]> {
  const factory = container.get<PostgresConnectionFactory>(TYPES.PostgresConnectionFactory);
  const client = await factory.connect(role, database);
  try {
    const { rows } = await client.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    );
    return rows.map((r) => r.tablename);
  } finally {
    await client.end();
  }
}

/** One known user in every tenant (identity tables arrive in P1-5). */
const USER_ID = randomUUID();
const oneUser: IPermissionResolver = {
  currentVersion: (_tenantId, userId) => Promise.resolve(userId === USER_ID ? 1 : null),
  resolve: (_tenantId, userId): Promise<PermissionGrants | null> =>
    Promise.resolve(
      userId === USER_ID
        ? { permissions: new Map([["users.list", { scope: "all" }]]), branchIds: [] }
        : null,
    ),
};

beforeAll(async () => {
  container = await createTestContainer();
  container.rebind<IPermissionResolver>(TYPES.PermissionResolver).toConstantValue(oneUser);
  [tenantA, tenantB] = await new TenantFixtures(container).pair();
  tenantTables = await tablesOf("migrator", TEST_DATABASE.templateDatabase);
  platformTables = await tablesOf("migrator", testConfig().database.platformDatabase);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("HTTP requests are confined to the token's tenant (container-wired app)", () => {
  const me = (token: string, slug?: string) => {
    const req = request(container.get<Express>(TYPES.HttpApp))
      .get("/api/v1/me")
      .set("Authorization", `Bearer ${token}`);
    return slug === undefined ? req : req.set("X-Tenant", slug);
  };

  it("serves tenant A's user as tenant A", async () => {
    const res = await me(await tenantA.accessToken(USER_ID), tenantA.slug);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      userId: USER_ID,
      tenant: { id: tenantA.id.value, slug: tenantA.slug },
      permissions: [{ key: "users.list", scope: "all" }],
    });
  });

  it("rejects tenant A's token addressed to tenant B", async () => {
    const res = await me(await tenantA.accessToken(USER_ID), tenantB.slug);
    expect([res.status, res.body.error.code]).toEqual([401, "TENANT_MISMATCH"]);
  });

  it("rejects tokens of a deactivated tenant", async () => {
    const closed = await new TenantFixtures(container).create({ status: "deactivated" });
    const res = await me(await closed.accessToken(USER_ID));
    expect([res.status, res.body.error.code]).toEqual([403, "TENANT_DEACTIVATED"]);
  });
});

describe("tenant schema coverage", () => {
  it("has an isolation fixture or a documented exemption for every tenant table", () => {
    const covered = new Set([
      ...Object.keys(TENANT_TABLE_FIXTURES),
      ...Object.keys(TENANT_TABLE_EXEMPTIONS),
    ]);
    // Discovery must work, or this check would pass vacuously.
    expect(tenantTables).toEqual(expect.arrayContaining(["outbox", "audit_logs", "tenant_info"]));
    const missing = tenantTables.filter((table) => !covered.has(table));
    expect(missing, "add these tables to testing/isolation/tenantTableFixtures.ts").toEqual([]);
    const stale = [...covered].filter((table) => !tenantTables.includes(table));
    expect(stale, "fixtures for tables that no longer exist").toEqual([]);
  });
});

describe("rows written by tenant A are invisible to tenant B", () => {
  for (const [table, fixture] of Object.entries(TENANT_TABLE_FIXTURES)) {
    it(table, async () => {
      const marker = `isolation-${randomUUID()}`;
      const { sql, params } = fixture.insert(marker);
      await tenantA.query(sql, params);

      expect(await tenantA.query(fixture.find, [marker])).toHaveLength(1);
      expect(await tenantB.query(fixture.find, [marker])).toHaveLength(0);
    });
  }
});

describe("tenant app role privileges", () => {
  type Privileges = {
    tablename: string;
    is_owner: boolean;
    can_truncate: boolean;
    can_trigger: boolean;
    can_references: boolean;
    can_insert: boolean;
    can_update: boolean;
    can_delete: boolean;
  };

  const privileges = (tenant: TestTenant) =>
    tenant.query<Privileges>(
      `select tablename,
              tableowner = current_user as is_owner,
              has_table_privilege(format('public.%I', tablename), 'TRUNCATE') as can_truncate,
              has_table_privilege(format('public.%I', tablename), 'TRIGGER') as can_trigger,
              has_table_privilege(format('public.%I', tablename), 'REFERENCES') as can_references,
              has_table_privilege(format('public.%I', tablename), 'INSERT') as can_insert,
              has_table_privilege(format('public.%I', tablename), 'UPDATE') as can_update,
              has_table_privilege(format('public.%I', tablename), 'DELETE') as can_delete
         from pg_tables where schemaname = 'public' order by tablename`,
    );

  it("owns no table and cannot truncate, add triggers or reference any table", async () => {
    const rows = await privileges(tenantA);
    expect(rows.map((r) => r.tablename)).toEqual(tenantTables);
    for (const row of rows) {
      expect(
        { table: row.tablename, owner: row.is_owner, truncate: row.can_truncate },
        row.tablename,
      ).toEqual({ table: row.tablename, owner: false, truncate: false });
      expect(row.can_trigger || row.can_references, row.tablename).toBe(false);
    }
  });

  it("cannot write the exempt tables", async () => {
    const rows = await privileges(tenantA);
    for (const table of Object.keys(TENANT_TABLE_EXEMPTIONS)) {
      const row = rows.find((r) => r.tablename === table);
      expect(row, table).toBeDefined();
      expect([row?.can_insert, row?.can_update, row?.can_delete], table).toEqual([
        false,
        false,
        false,
      ]);
    }
  });

  for (const table of APPEND_ONLY_TENANT_TABLES) {
    it(`cannot change or delete rows of append-only ${table}`, async () => {
      const fixture = TENANT_TABLE_FIXTURES[table];
      if (fixture === undefined) throw new Error(`${table} needs a fixture`);
      const marker = `append-only-${randomUUID()}`;
      const { sql, params } = fixture.insert(marker);
      await tenantA.query(sql, params);
      await expect(tenantA.query(`update ${table} set metadata = '{}'`)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(tenantA.query(`delete from ${table}`)).rejects.toMatchObject({ code: "42501" });
    });
  }

  it("cannot create objects in a tenant database", async () => {
    await expect(tenantA.query("create table evil (id int)")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      tenantA.query("create function evil() returns int language sql as 'select 1'"),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("platform app role privileges", () => {
  it("owns no platform table and cannot truncate any", async () => {
    const pool = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
    const { rows } = await pool.query<{
      tablename: string;
      is_owner: boolean;
      can_truncate: boolean;
    }>(
      `select tablename, tableowner = current_user as is_owner,
              has_table_privilege(format('public.%I', tablename), 'TRUNCATE') as can_truncate
         from pg_tables where schemaname = 'public' order by tablename`,
    );
    expect(rows.map((r) => r.tablename)).toEqual(platformTables);
    for (const row of rows) {
      expect([row.is_owner, row.can_truncate], row.tablename).toEqual([false, false]);
    }
  });

  it("cannot change or delete platform audit entries", async () => {
    const pool = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
    await pool.query(
      "insert into platform_audit_logs (actor_type, action, entity_type) values ('system', 'isolation.check', 'test')",
    );
    await expect(pool.query("update platform_audit_logs set reason = 'x'")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(pool.query("delete from platform_audit_logs")).rejects.toMatchObject({
      code: "42501",
    });
  });
});
