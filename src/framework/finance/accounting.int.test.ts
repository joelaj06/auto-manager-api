import type { Express } from "express";
import type { Container } from "inversify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * Accounting export and reconciliation (P9-5) end to end: journals exported for QuickBooks, Xero
 * and as CSV with mapped accounts, summed by month, and a second export of a period told; a bank
 * statement checked and imported with its lines matched by reference and by amount and date,
 * a banked batch matched by hand, bank charges and a cash deposit posted from their lines, an
 * overlapping statement adding only what is new, the difference brought to nothing, and matches
 * undone, statements voided and a locked period respected.
 */
let container: Container;
let app: Express;
let t: ProvisionedTenant;
let customer: string;
const accounts = new Map<string, string>();
const paid = new Map<string, string>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked by expect()
type Body = any;

const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const dayAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const dmy = (date: string) => date.split("-").reverse().join("/");
const FROM = dayAgo(10);
const TO = dayAgo(0);
const bank = () => accounts.get("bank")!;

function ok(res: request.Response, status = 200): Body {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data;
}

async function payment(key: string, body: Record<string, unknown>): Promise<void> {
  const created = ok(
    await api()
      .post("/api/v1/payments")
      .set(owner())
      .send({ direction: "in", partyType: "customer", partyId: customer, ...body }),
    201,
  );
  paid.set(key, created.id);
}

const exportFile = (query: string) =>
  api().get(`/api/v1/accounting/export?from=${FROM}&to=${TO}&${query}`).set(owner());

const importStatement = (csv: string, extra: Record<string, unknown> = {}) =>
  api()
    .post("/api/v1/reconciliation/imports")
    .set(owner())
    .send({ accountId: bank(), fileName: "ecobank.csv", csv, commit: true, ...extra });

async function unmatchedLines(accountId = bank()): Promise<Body[]> {
  return ok(
    await api().get(`/api/v1/reconciliation/lines?accountId=${accountId}`).set(owner()),
  ) as Body[];
}

const summary = async (): Promise<Body> =>
  ok(await api().get(`/api/v1/reconciliation/summary?accountId=${bank()}`).set(owner()));

const statement = (rows: readonly string[]) =>
  ["Ecobank Ghana statement", "Value Date,Narration,Ref,Debit,Credit,Balance", ...rows].join("\n");

const FIRST = [
  `${dmy(dayAgo(6))},Transfer from Ama,,,300.00,300.00`,
  `${dmy(dayAgo(5))},Fuel supplier PAY,BNK-5521,120.00,,180.00`,
  `${dmy(dayAgo(4))},Deposit batch,,,100.00,280.00`,
  `${dmy(dayAgo(3))},Monthly charges,,5.00,,275.00`,
];
const LATER = `${dmy(dayAgo(2))},Cash lodged,,,"1,000.00","1,275.00"`;

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  customer = ok(
    await api()
      .post("/api/v1/customers")
      .set(owner())
      .send({
        type: "corporate",
        companyName: "Osu Traders",
        phone: `+23324${String(Date.now()).slice(-7)}`,
      }),
    201,
  ).id;
  const listed = ok(await api().get("/api/v1/ledger/accounts").set(owner())) as Body[];
  for (const a of listed) if (a.systemKey !== null) accounts.set(a.systemKey, a.id);

  await payment("transfer", {
    method: "bank_transfer",
    amount: "300.00",
    paidOn: dayAgo(6),
  });
  await payment("supplier", {
    direction: "out",
    method: "bank_transfer",
    amount: "120.00",
    paidOn: dayAgo(5),
    reference: "BNK-5521",
    counterAccountId: accounts.get("other_expenses"),
  });
  await payment("batch1", { method: "bank_transfer", amount: "60.00", paidOn: dayAgo(4) });
  await payment("batch2", { method: "bank_transfer", amount: "40.00", paidOn: dayAgo(4) });
  await payment("momo", {
    method: "momo",
    momoNetwork: "mtn",
    amount: "250.00",
    paidOn: dayAgo(3),
    reference: "90221133",
  });
}, 120_000);

afterAll(async () => {
  await disposeContainer(container);
});

describe("accounting export", () => {
  it("exports journals in each format, under the package's names, and keeps them balanced", async () => {
    const plain = await exportFile("format=csv");
    expect(plain.status, plain.text).toBe(200);
    expect(plain.headers["content-type"]).toContain("text/csv");
    expect(plain.headers["x-export-overlaps"]).toBe("0");
    const rows = plain.text.trim().split("\r\n");
    expect(rows[0]).toContain("journal,date,description,source,account_code");
    expect(plain.text).toContain("Osu Traders");
    expect(rows).toHaveLength(11);

    ok(
      await api()
        .put("/api/v1/accounting/mappings")
        .set(owner())
        .send({
          target: "quickbooks",
          mappings: [{ accountId: bank(), external: "Ecobank Current" }],
        }),
    );
    const qb = await exportFile("format=quickbooks");
    expect(qb.text.split("\r\n")[0]).toContain("Journal No,Journal Date,Account Name,Debits");
    expect(qb.text).toContain("Ecobank Current");
    expect(qb.text).toContain(dmy(dayAgo(6)));
    // A mapping belongs to its package.
    const xero = await exportFile("format=xero&xeroTaxRate=No%20Tax");
    expect(xero.text).not.toContain("Ecobank Current");
    const amounts = xero.text
      .trim()
      .split("\r\n")
      .slice(1)
      .map((row) => Number(row.split(",").at(-1)));
    expect(amounts.reduce((sum, a) => sum + a, 0)).toBeCloseTo(0, 2);
    expect(xero.text).toContain(",No Tax,-120.00");

    const unmapped = await api()
      .put("/api/v1/accounting/mappings")
      .set(owner())
      .send({ target: "xero", mappings: [{ accountId: customer, external: "Nope" }] });
    expect(unmapped.status).toBe(422);
  });

  it("sums a period by month and tells what has been exported before", async () => {
    const month = await exportFile("format=csv&detail=month");
    expect(Number(month.headers["x-export-lines"])).toBeLessThan(10);
    expect(month.headers["x-export-overlaps"]).toBe("1");
    expect(month.text).toContain("Autoforce summary");

    await payment("late", {
      method: "momo",
      momoNetwork: "mtn",
      amount: "10.00",
      paidOn: dayAgo(1),
    });
    const history = ok(await api().get("/api/v1/accounting/exports").set(owner())) as Body[];
    expect(history).toHaveLength(4);
    expect(history[0]).toMatchObject({ format: "csv", detail: "month", postedSince: 1 });
  });

  it("refuses an empty period and one too long", async () => {
    const empty = await api()
      .get("/api/v1/accounting/export?format=csv&from=2020-01-01&to=2020-01-31")
      .set(owner());
    expect(empty.status).toBe(422);
    const long = await api()
      .get("/api/v1/accounting/export?format=csv&from=2020-01-01&to=2022-01-31")
      .set(owner());
    expect(long.status).toBe(422);
  });
});

describe("reconciliation", () => {
  it("checks a statement without keeping anything, and points at rows it cannot read", async () => {
    const checked = ok(await importStatement(statement(FIRST), { commit: false }));
    expect(checked).toMatchObject({
      committed: false,
      import: null,
      lines: 4,
      duplicates: 0,
      from: dayAgo(6),
      to: dayAgo(3),
    });
    expect(checked.moneyIn.amountMinor).toBe(40_000);
    expect(checked.moneyOut.amountMinor).toBe(12_500);
    expect(checked.columns).toMatchObject({ date: "Value Date", description: "Narration" });
    expect(await unmatchedLines()).toEqual([]);

    const broken = statement([...FIRST, "soon,Bad,,,1.00,"]);
    expect(ok(await importStatement(broken, { commit: false })).errors).toEqual([
      { row: 7, message: '"soon" is not a date' },
    ]);
    expect((await importStatement(broken)).status).toBe(422);
    const notBank = await importStatement(statement(FIRST), { accountId: accounts.get("cash") });
    expect(notBank.status).toBe(422);
  });

  it("matches lines by reference and by amount and date, and leaves the rest", async () => {
    const done = ok(await importStatement(statement(FIRST)));
    expect(done.import).toMatchObject({ lines: 4, autoMatched: 2, status: "active" });
    const left = await unmatchedLines();
    expect((left as { description: string }[]).map((l) => l.description)).toEqual([
      "Deposit batch",
      "Monthly charges",
    ]);
    expect(left[0].suggestions).toEqual([]);
    const pending = ok(
      await api()
        .get(`/api/v1/reconciliation/ledger-lines?accountId=${bank()}&from=${FROM}&to=${TO}`)
        .set(owner()),
    ) as Body[];
    expect(
      pending.map((l: { amount: { amountMinor: number } }) => l.amount.amountMinor).sort(),
    ).toEqual([4_000, 6_000]);
    expect((await summary()).reconciled).toBe(false);
  });

  it("matches a banked batch by hand, only for its exact total", async () => {
    const [batch] = await unmatchedLines();
    const pending = ok(
      await api()
        .get(`/api/v1/reconciliation/ledger-lines?accountId=${bank()}&from=${FROM}&to=${TO}`)
        .set(owner()),
    ) as Body[];
    const ids = pending.map((l) => l.ledgerLineId as string);
    const short = await api()
      .post("/api/v1/reconciliation/match")
      .set(owner())
      .send({ statementLineId: batch.id, ledgerLineIds: [ids[0]] });
    expect(short.status).toBe(422);
    const matched = ok(
      await api()
        .post("/api/v1/reconciliation/match")
        .set(owner())
        .send({ statementLineId: batch.id, ledgerLineIds: ids }),
    );
    expect(matched).toMatchObject({ status: "matched", matchKind: "manual" });
    const again = await api()
      .post("/api/v1/reconciliation/match")
      .set(owner())
      .send({ statementLineId: batch.id, ledgerLineIds: ids });
    expect(again.status).toBe(422);
  });

  it("posts what the books lack from the line", async () => {
    const [charges] = await unmatchedLines();
    const posted = ok(
      await api()
        .post(`/api/v1/reconciliation/lines/${charges.id}/post`)
        .set(owner())
        .send({ counterAccountId: accounts.get("other_expenses"), description: "Bank charges" }),
    );
    expect(posted).toMatchObject({ status: "matched", matchKind: "posted" });
    expect(posted.journalEntryId).not.toBeNull();
    const s = await summary();
    expect(s.ledgerBalance.amountMinor).toBe(27_500);
    expect(s.difference.amountMinor).toBe(0);
    expect(s.reconciled).toBe(true);
  });

  it("adds only what is new from an overlapping statement", async () => {
    const done = ok(await importStatement(statement([...FIRST, LATER])));
    expect(done.import).toMatchObject({ lines: 1, duplicates: 4 });
    const [lodged] = await unmatchedLines();
    expect(lodged.amount.amountMinor).toBe(100_000);
    const s = await summary();
    expect(s.statementBalance.amountMinor).toBe(127_500);
    expect(s.unmatchedStatement).toMatchObject({ lines: 1 });
    expect(s.difference.amountMinor).toBe(0);
    expect(s.reconciled).toBe(false);
    const same = await importStatement(statement([...FIRST, LATER]));
    expect(same.status).toBe(422);
    ok(
      await api()
        .post(`/api/v1/reconciliation/lines/${lodged.id}/post`)
        .set(owner())
        .send({ counterAccountId: accounts.get("cash") }),
    );
    expect((await summary()).reconciled).toBe(true);
  });

  it("reads a mobile money statement and matches on the transaction id", async () => {
    const csv = [
      "Transaction ID,Date,Transaction Type,Amount,Balance",
      `90221133,${dayAgo(1)} 14:02:11,Debit Payment,250.00,250.00`,
    ].join("\n");
    const done = ok(
      await importStatement(csv, { accountId: accounts.get("momo"), fileName: "mtn.csv" }),
    );
    expect(done.import.autoMatched).toBe(1);
    const report = await api()
      .post("/api/v1/reports/bank_reconciliation/run")
      .set(owner())
      .send({ params: { accountId: bank() } });
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(JSON.stringify(report.body.data.summary)).toContain("Yes");
  });

  it("flags a matched payment reversed later, and puts a line back on request", async () => {
    ok(
      await api()
        .post(`/api/v1/payments/${paid.get("transfer")}/reverse`)
        .set(owner())
        .send({ reason: "Entered twice" }),
    );
    const s = await summary();
    expect(s.matchedThenReversed).toBe(1);
    expect(s.reconciled).toBe(false);

    const matched = ok(
      await api()
        .get(`/api/v1/reconciliation/lines?accountId=${bank()}&status=matched&limit=100`)
        .set(owner()),
    ) as Body[];
    const transfer = matched.find((l) => l.description === "Transfer from Ama");
    expect(transfer.matchKind).toBe("auto");
    ok(await api().post(`/api/v1/reconciliation/lines/${transfer.id}/unmatch`).set(owner()));
    ok(
      await api()
        .post(`/api/v1/reconciliation/lines/${transfer.id}/ignore`)
        .set(owner())
        .send({ note: "Refunded by the bank outside the system" }),
    );
    const after = await summary();
    expect(after.ignored).toMatchObject({ lines: 1 });
    expect(after.ignored.amount.amountMinor).toBe(30_000);
    expect(after.matchedThenReversed).toBe(0);
    expect(after.difference.amountMinor).toBe(0);
  });

  it("reverses a posted entry when its line is undone, and voids a statement after that", async () => {
    const imports = ok(
      await api().get(`/api/v1/reconciliation/imports?accountId=${bank()}`).set(owner()),
    ) as Body[];
    const first = imports.at(-1);
    const refused = await api()
      .post(`/api/v1/reconciliation/imports/${first.id}/void`)
      .set(owner());
    expect(refused.status).toBe(422);

    const matched = ok(
      await api()
        .get(`/api/v1/reconciliation/lines?accountId=${bank()}&status=matched&limit=100`)
        .set(owner()),
    ) as Body[];
    const charges = matched.find((l) => l.description === "Monthly charges");
    const before = (await summary()).ledgerBalance.amountMinor as number;
    const undone = ok(
      await api().post(`/api/v1/reconciliation/lines/${charges.id}/unmatch`).set(owner()),
    );
    expect(undone).toMatchObject({ status: "unmatched", matchKind: null, journalEntryId: null });
    expect((await summary()).ledgerBalance.amountMinor).toBe(before + 500);

    await api().post(`/api/v1/reconciliation/imports/${first.id}/void`).set(owner()).expect(204);
    expect(
      ((await unmatchedLines()) as { description: string }[]).map((l) => l.description),
    ).toEqual([]);
    const history = ok(
      await api().get(`/api/v1/reconciliation/imports?accountId=${bank()}`).set(owner()),
    ) as Body[];
    expect(history.at(-1).status).toBe("voided");
    // Its lines can come in again.
    expect(ok(await importStatement(statement(FIRST))).import.lines).toBe(4);
  });

  it("will not post into a locked period, and the books stay sound", async () => {
    const [line] = (await unmatchedLines()).filter((l) => l.description === "Monthly charges");
    ok(
      await api()
        .put("/api/v1/ledger/period-lock")
        .set(owner())
        .send({ lockedUntil: dayAgo(1), reason: "Month closed" }),
    );
    const locked = await api()
      .post(`/api/v1/reconciliation/lines/${line.id}/post`)
      .set(owner())
      .send({ counterAccountId: accounts.get("other_expenses") });
    expect(locked.status).toBe(409);
    const integrity = ok(await api().get("/api/v1/ledger/integrity").set(owner()));
    expect(integrity.passed, JSON.stringify(integrity.checks)).toBe(true);
    expect(
      (integrity.checks as { name: string }[]).some((c) => c.name === "statement matches"),
    ).toBe(true);
  });
});
