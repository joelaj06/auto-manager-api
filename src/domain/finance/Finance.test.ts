import { describe, expect, it } from "vitest";
import { TaxCode } from "../tax/TaxCode.js";
import { standardTaxCodes } from "../tax/TaxTemplates.js";
import { CashSession } from "./CashSession.js";
import { Invoice, type InvoiceHeader, type InvoiceLineInput } from "./Invoice.js";
import { credit, debit, journal, reversal, type SystemAccountKey } from "./Journal.js";
import { Payment } from "./Payment.js";
import { Postings } from "./Postings.js";

const now = new Date("2026-10-19T09:00:00Z");
let next = 0;
const ids = () => `id-${(next += 1)}`;
const taxCodes = new Map(standardTaxCodes("GH", ids).map((p) => [p.code, TaxCode.create(p)]));
const accounts = (key: SystemAccountKey) => `acc:${key}`;

const header = (overrides: Partial<InvoiceHeader> = {}): InvoiceHeader => ({
  partyType: "customer",
  partyId: "c1",
  partyName: "Ama Owusu",
  branchId: "b1",
  vehicleId: null,
  issueDate: "2026-10-19",
  dueDate: "2026-10-19",
  currency: "GHS",
  fxRate: "1",
  pricesIncludeTax: false,
  notes: null,
  ...overrides,
});
const line = (overrides: Partial<InvoiceLineInput> = {}): InvoiceLineInput => ({
  description: "Car rental, 2 days",
  quantity: 2,
  unitPriceMinor: 50_000,
  discountMinor: 0,
  taxCode: "VAT_STANDARD",
  accountId: "acc:rental",
  vehicleId: "v1",
  ...overrides,
});
const draft = (h: Partial<InvoiceHeader> = {}, lines = [line()]) =>
  Invoice.draft({
    id: "inv1",
    header: header(h),
    lines,
    taxCodes,
    source: null,
    createdBy: "u1",
    now,
  });

describe("Ghana standard rate (Act 1151, from 2026-01-01)", () => {
  it("charges VAT 15%, NHIL 2.5% and GETFund 2.5% on the same value: 20%", () => {
    const invoice = draft().snapshot();
    expect([invoice.subtotalMinor, invoice.taxMinor, invoice.totalMinor]).toEqual([
      100_000, 20_000, 120_000,
    ]);
    expect(invoice.lines[0]!.taxComponents.map((c) => [c.key, c.rate, c.amountMinor])).toEqual([
      ["vat", "15", 15_000],
      ["nhil", "2.5", 2_500],
      ["getfund", "2.5", 2_500],
    ]);
  });

  it("works tax-inclusive prices back with the 1/6 fraction", () => {
    const invoice = draft({ pricesIncludeTax: true }, [
      line({ quantity: 1, unitPriceMinor: 120_000 }),
    ]).snapshot();
    expect([invoice.subtotalMinor, invoice.taxMinor, invoice.totalMinor]).toEqual([
      100_000, 20_000, 120_000,
    ]);
  });

  it("has no standard rate before 2026 in the seeded code (earlier rates are entered as periods)", () => {
    expect(() => draft({ issueDate: "2025-12-31", dueDate: "2025-12-31" })).toThrow(/No rates/);
  });
});

describe("journal", () => {
  it("merges lines, refuses unbalanced entries and reverses exactly", () => {
    const entry = journal({
      date: "2026-10-19",
      description: "test",
      source: { type: "t", id: "1" },
      reversesId: null,
      lines: [
        debit(100, { accountId: "a" }),
        debit(50, { accountId: "a" }),
        credit(150, { accountId: "b" }),
        credit(0, { accountId: "c" }),
      ],
    });
    expect(entry.lines.map((l) => [l.accountId, l.debitMinor, l.creditMinor])).toEqual([
      ["a", 150, 0],
      ["b", 0, 150],
    ]);
    expect(() =>
      journal({
        ...entry,
        lines: [debit(100, { accountId: "a" }), credit(99, { accountId: "b" })],
      }),
    ).toThrow(/must balance/);
    const back = reversal({ ...entry, id: "e1" }, "2026-10-20", "undo");
    expect(back.reversesId).toBe("e1");
    expect(back.lines.map((l) => [l.accountId, l.debitMinor, l.creditMinor])).toEqual([
      ["a", 0, 150],
      ["b", 150, 0],
    ]);
  });
});

describe("postings", () => {
  it("posts an issued invoice: receivable against income and each levy", () => {
    const invoice = draft();
    invoice.issue({ number: "INV-2026-000001", taxCodes, issuedBy: "u1", now });
    const entry = Postings.invoiceIssued(invoice, accounts, "GHS");
    expect(entry.lines.map((l) => [l.accountId, l.debitMinor, l.creditMinor])).toEqual([
      ["acc:receivables", 120_000, 0],
      ["acc:rental", 0, 100_000],
      ["acc:tax_payable:vat", 0, 15_000],
      ["acc:tax_payable:nhil", 0, 2_500],
      ["acc:tax_payable:getfund", 0, 2_500],
    ]);
  });

  it("books exchange differences when a USD payment pays a USD invoice at another rate", () => {
    const invoice = draft({ currency: "USD", fxRate: "15" }, [
      line({ taxCode: null, quantity: 1, unitPriceMinor: 10_000 }),
    ]);
    invoice.issue({ number: "INV-1", taxCodes, issuedBy: null, now });
    const payment = Payment.record({
      id: "p1",
      number: "RCT-1",
      direction: "in",
      method: "bank_transfer",
      party: { type: "customer", id: "c1" },
      partyName: "Ama Owusu",
      branchId: "b1",
      paidOn: "2026-10-20",
      currency: "USD",
      fxRate: "15.5",
      amountMinor: 10_000,
      amountBaseMinor: 155_000,
      counterAccountId: null,
      reference: null,
      momoNetwork: null,
      cashSessionId: null,
      vehicleId: null,
      notes: null,
      recordedBy: null,
      recordedAt: now,
    });
    const entry = Postings.allocation(
      { allocationId: "a1", payment, invoice, amountMinor: 10_000, date: "2026-10-20" },
      accounts,
      "GHS",
    );
    expect(entry.lines.map((l) => [l.accountId, l.debitMinor, l.creditMinor])).toEqual([
      ["acc:party_credit", 155_000, 0],
      ["acc:receivables", 0, 150_000],
      ["acc:fx_difference", 0, 5_000],
    ]);
  });
});

describe("invoice lifecycle", () => {
  it("is paid in parts and voided only without payments", () => {
    const invoice = draft();
    expect(() => invoice.applyPayment(1, now)).toThrow(/draft invoice takes no payment/);
    invoice.issue({ number: "INV-1", taxCodes, issuedBy: null, now });
    invoice.applyPayment(20_000, now);
    expect([invoice.status, invoice.balanceMinor]).toEqual(["partially_paid", 100_000]);
    expect(() => invoice.applyPayment(100_001, now)).toThrow(/still due/);
    expect(() => invoice.void("mistake", null, now)).toThrow(/Release the payments/);
    invoice.applyPayment(100_000, now);
    expect(invoice.status).toBe("paid");
    invoice.releasePayment(120_000, now);
    invoice.void("Wrong customer", null, now);
    expect(invoice.status).toBe("void");
  });
});

describe("cash session", () => {
  it("expects float + in − out and reports the variance at close", () => {
    const session = CashSession.open({
      id: "s1",
      branchId: "b1",
      cashierId: "u1",
      floatMinor: 20_000,
      now,
    });
    session.record("in", 50_000);
    session.record("out", 10_000);
    expect(session.expectedMinor).toBe(60_000);
    expect(() => session.record("out", 70_000)).toThrow(/not that much cash/);
    expect(session.close(59_500, "u1", null, now)).toBe(-500);
    const entry = Postings.cashVariance(session, accounts, "2026-10-19")!;
    expect(entry.lines.map((l) => [l.accountId, l.debitMinor, l.creditMinor])).toEqual([
      ["acc:cash_over_short", 500, 0],
      ["acc:cash", 0, 500],
    ]);
  });
});
