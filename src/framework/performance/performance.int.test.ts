import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ILedger } from "../../application/ports/IFinanceRecords.js";
import type { ITenantContext } from "../../application/ports/ITenantContext.js";
import type { MigrationSets } from "../../infrastructure/database/migrations/MigrationCatalog.js";
import type { PostgresConnectionFactory } from "../../infrastructure/database/postgres/PostgresConnectionFactory.js";
import type { PostgresTransactionContext } from "../../infrastructure/database/postgres/PostgresTransactionContext.js";
import { TenantConnectionPools } from "../../infrastructure/database/postgres/TenantConnectionPools.js";
import type { TenantDatabaseNaming } from "../../infrastructure/database/postgres/TenantDatabaseNaming.js";
import {
  PostgresReportUnitOfWork,
  type ReportReadFallback,
} from "../../infrastructure/database/PostgresReportUnitOfWork.js";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * The performance pass (P8-5) end to end: an index behind every foreign key but the
 * who-did-it columns, the ledger rolled up by day with later lines read live so the trial balance
 * and tax report never change, and catalogue reports reading a replica (here the same server)
 * in a read-only transaction with the report timeout — or the primary when the replica is out.
 */
let container: Container;
let app: Express;
let platform: pg.Pool;
let t: ProvisionedTenant;
let customer: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked by expect()
type Body = any;

const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
const tenantRun = <T>(fn: () => Promise<T>) =>
  container.get<ITenantContext>(TYPES.TenantContext).runAs(t.tenant.id, fn);
const rollUp = () => t.tenant.run(() => container.get<ILedger>(TYPES.Ledger).rollUp(0));

/** Unindexed foreign keys but those of who-did-it columns pointing at `users`. */
const UNINDEXED = (users: string) => `
  select c.conrelid::regclass::text || ' ' || pg_get_constraintdef(c.oid) as fk
    from pg_constraint c
   where c.contype = 'f' and c.connamespace = 'public'::regnamespace
     and not exists (
       select 1 from pg_index i
        where i.indrelid = c.conrelid
          and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey
          and c.conkey @> (i.indkey::int2[])[0:cardinality(c.conkey) - 1])
     and not (c.confrelid = '${users}'::regclass and cardinality(c.conkey) = 1
              and (select a.attname from pg_attribute a
                    where a.attrelid = c.conrelid and a.attnum = c.conkey[1])
                  ~ '(_by|^actor_id|^author_id|_by_staff_id|^owner_signer_id)$')
   order by 1`;

async function trialBalance(): Promise<Body> {
  const res = await api().get("/api/v1/ledger/trial-balance").set(owner());
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.data.balanced).toBe(true);
  return (res.body.data.accounts as { code: string; balance: { amountMinor: number } }[]).map(
    (a) => [a.code, a.balance.amountMinor],
  );
}

async function taxReport(): Promise<Body> {
  const res = await api().post("/api/v1/reports/tax_report/run").set(owner()).send({ params: {} });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.rows;
}

/** Each account's totals through `ledger_activity` against the lines themselves. */
async function activityMatchesLines(): Promise<void> {
  const rows = await t.tenant.query<{ account_id: string; rolled: string; raw: string }>(
    `select a.id as account_id,
            (select coalesce(sum(debit_minor - credit_minor), 0) from ledger_activity
              where account_id = a.id) as rolled,
            (select coalesce(sum(debit_minor - credit_minor), 0) from ledger_lines
              where account_id = a.id) as raw
       from ledger_accounts a`,
  );
  for (const r of rows) expect(r.rolled, r.account_id).toBe(r.raw);
}

async function issueInvoice() {
  const draft = await api()
    .post("/api/v1/invoices")
    .set(owner())
    .send({
      partyType: "customer",
      partyId: customer,
      lines: [{ description: "Car rental", quantity: 2, unitPrice: "500.00" }],
    });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const res = await api().post(`/api/v1/invoices/${draft.body.data.id}/issue`).set(owner());
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

/** A report unit of work whose replica is this server, or a port where nothing listens. */
function replicaAt(port: number | undefined) {
  const factory = container.get<PostgresConnectionFactory>(TYPES.PostgresConnectionFactory);
  const naming = container.get<TenantDatabaseNaming>(TYPES.TenantDatabaseNaming);
  const sets = container.get<MigrationSets>(TYPES.MigrationSets);
  const fallbacks: ReportReadFallback[] = [];
  const unit = new PostgresReportUnitOfWork({
    tenantContext: container.get<ITenantContext>(TYPES.TenantContext),
    primary: container.get<TenantConnectionPools>(TYPES.TenantConnectionPools),
    replica: {
      pools: new TenantConnectionPools({
        clientConfigFor: (name) => ({
          ...factory.clientConfig("tenant", name),
          ...(port === undefined ? {} : { port }),
        }),
        databaseNameFor: (id) => naming.databaseNameFor(id),
        maxPools: 2,
        maxConnectionsPerPool: 1,
        idleTimeoutMs: 1_000,
        statementTimeoutMs: 5_000,
        requiredSchemaVersion: sets.tenant.latestVersion,
      }),
      maxLagSeconds: 30,
    },
    transactions: container.get<PostgresTransactionContext>(TYPES.PostgresTransactionContext),
    statementTimeoutMs: 5_000,
    onFallback: (f) => fallbacks.push(f),
  });
  return { unit, fallbacks };
}

beforeAll(async () => {
  container = await createTestContainer({
    AUTH_RATE_LIMIT_MAX: "10000",
    RATE_LIMIT_MAX: "100000",
    // The primary stands in for its replica: reports take the replica's path.
    DATABASE_REPLICA_HOST: process.env.DATABASE_HOST ?? "localhost",
  });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  const res = await api()
    .post("/api/v1/customers")
    .set(owner())
    .send({ type: "individual", firstName: "Ama", lastName: "Owusu", phone: `024${digits(7)}` });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  customer = res.body.data.id as string;
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("performance pass", () => {
  it("indexes every foreign key but the who-did-it columns", async () => {
    expect((await t.tenant.query<{ fk: string }>(UNINDEXED("users"))).map((r) => r.fk)).toEqual([]);
    const { rows } = await platform.query<{ fk: string }>(UNINDEXED("platform_users"));
    expect(rows.map((r) => r.fk)).toEqual([]);
  });

  it("rolls the ledger up by day without changing a balance", async () => {
    await issueInvoice();
    const before = await trialBalance();
    const taxBefore = await taxReport();

    expect(await rollUp()).toBeGreaterThan(0);
    const totals = await t.tenant.query<{ n: string }>(
      "select count(*) as n from ledger_daily_totals",
    );
    expect(Number(totals[0]!.n)).toBeGreaterThan(0);
    expect(await trialBalance()).toEqual(before);
    expect(await taxReport()).toEqual(taxBefore);
    await activityMatchesLines();
    expect(await rollUp()).toBe(0);

    // Posted after the roll-up: read live until the next one, which adds only its lines.
    await issueInvoice();
    const after = await trialBalance();
    expect(after).not.toEqual(before);
    await activityMatchesLines();
    const added = await t.tenant.query<{ n: string }>(
      `select count(*) as n from ledger_lines l join journal_entries e on e.id = l.entry_id
        where e.created_at >= (select rolled_until from ledger_rollup)`,
    );
    expect(await rollUp()).toBe(Number(added[0]!.n));
    expect(await trialBalance()).toEqual(after);
    await activityMatchesLines();
  });

  it("reads reports in a read-only transaction with the report timeout", async () => {
    const report = container.get<PostgresReportUnitOfWork>(TYPES.ReportUnitOfWork);
    const tx = container.get<PostgresTransactionContext>(TYPES.PostgresTransactionContext);
    const settings = await tenantRun(() =>
      report.run(async () => {
        const { rows } = await tx.current().query<{ ro: string; timeout: string }>(
          `select current_setting('transaction_read_only') as ro,
                  current_setting('statement_timeout') as timeout`,
        );
        return rows[0]!;
      }),
    );
    expect(settings).toEqual({ ro: "on", timeout: "1min" });
    expect((await taxReport()).length).toBeGreaterThan(0);
  });

  it("reads the primary when the replica cannot be reached", async () => {
    const tx = container.get<PostgresTransactionContext>(TYPES.PostgresTransactionContext);
    const readOnly = () =>
      tenantRun(() =>
        out.unit.run(async () => {
          const { rows } = await tx
            .current()
            .query<{ ro: string }>("select current_setting('transaction_read_only') as ro");
          return rows[0]!.ro;
        }),
      );
    const out = replicaAt(1);
    const up = replicaAt(undefined);
    try {
      expect(await readOnly()).toBe("on");
      expect(out.fallbacks.map((f) => f.reason)).toEqual(["unavailable"]);

      // The report's own error is not taken for the replica's: no second try on the primary.
      await expect(
        tenantRun(() => up.unit.run(() => Promise.reject(new Error("report failed")))),
      ).rejects.toThrow("report failed");
      expect(up.fallbacks).toEqual([]);
    } finally {
      await out.unit.close();
      await up.unit.close();
    }
  });
});
