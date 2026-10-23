import { describe, expect, it } from "vitest";
import {
  EnterpriseQuote,
  quoteLine,
  QuoteRuleError,
  type QuoteLineInput,
} from "./EnterpriseQuote.js";

const NOW = new Date("2026-11-02T09:00:00Z");
const LINES: QuoteLineInput[] = [
  { kind: "branch_rate", description: "Negotiated rate", quantity: 12, unitMinor: 20_000 },
  {
    kind: "size_adjustment",
    description: "Large fleet (400 vehicles)",
    quantity: 1,
    unitMinor: 50_000,
  },
  { kind: "setup", description: "Data import and training", quantity: 1, unitMinor: 300_000 },
  {
    kind: "discount",
    description: "Annual contract",
    quantity: 1,
    unitMinor: -10_000,
    recurrence: "monthly",
  },
];

const draft = (lines = LINES, validUntil: string | null = "2026-11-30") =>
  EnterpriseQuote.draft({
    id: "q1",
    code: "AF-QUO-2026-000001",
    tenantId: "t1",
    subscriptionId: "s1",
    version: 1,
    currency: "GHS",
    terms: { lines, sizeBand: "large", sizeNote: " 400 vehicles ", validUntil },
    createdBy: "staff",
    now: NOW,
  });

describe("enterprise quote lines", () => {
  it("defaults recurrence and the licence flag by kind", () => {
    expect(quoteLine(LINES[0]!)).toMatchObject({ recurrence: "monthly", countsAsLicence: true });
    expect(quoteLine(LINES[2]!)).toMatchObject({ recurrence: "one_time", countsAsLicence: false });
    expect(
      quoteLine({ kind: "other", description: "Dedicated database", quantity: 1, unitMinor: 9 }),
    ).toMatchObject({ recurrence: "one_time", countsAsLicence: false });
    expect(
      quoteLine({ ...LINES[2]!, kind: "other", countsAsLicence: true, recurrence: "monthly" }),
    ).toMatchObject({ recurrence: "monthly", countsAsLicence: true });
  });

  it("refuses a kind with the wrong recurrence, zero or misplaced negative amounts", () => {
    expect(() => quoteLine({ ...LINES[0]!, recurrence: "one_time" })).toThrow(/monthly/);
    expect(() => quoteLine({ ...LINES[2]!, recurrence: "monthly" })).toThrow(/one-time/);
    expect(() => quoteLine({ ...LINES[0]!, unitMinor: -5 })).toThrow(QuoteRuleError);
    expect(() => quoteLine({ ...LINES[3]!, unitMinor: 5 })).toThrow(QuoteRuleError);
    expect(() => quoteLine({ ...LINES[0]!, unitMinor: 0 })).toThrow(QuoteRuleError);
  });
});

describe("an enterprise quote", () => {
  it("totals monthly and one-time lines", () => {
    const q = draft().snapshot();
    expect(q).toMatchObject({
      recurringMinor: 12 * 20_000 + 50_000 - 10_000,
      oneTimeMinor: 300_000,
      sizeNote: "400 vehicles",
      status: "draft",
    });
    expect(draft().branches).toBe(12);
    expect(draft().branchRateMinor).toBe(20_000);
  });

  it("is edited only as a draft, and sent with a per-branch rate and a validity", () => {
    expect(() => draft([LINES[2]!]).send("admin", NOW)).toThrow(/per-branch rate/);
    expect(() => draft(LINES, null).send("admin", NOW)).toThrow(/valid-until/);
    expect(() => draft(LINES, "2027-03-01").send("admin", NOW)).toThrow(/90 days/);
    expect(() => draft([...LINES, LINES[0]!])).toThrow(/one per-branch rate/);
    const quote = draft();
    quote.send("admin", NOW);
    expect(quote.snapshot()).toMatchObject({ status: "sent", approvedBy: "admin", sentAt: NOW });
    expect(() => quote.edit({ lines: LINES }, NOW)).toThrow(/sent/);
  });

  it("is accepted until it expires, then superseded; drafts and sent quotes are withdrawn", () => {
    const quote = draft();
    quote.send("admin", NOW);
    expect(() =>
      quote.accept({ type: "user", id: "u1" }, new Date("2026-12-01T00:00:00Z")),
    ).toThrow(/expired/);
    quote.accept({ type: "user", id: "u1" }, NOW);
    expect(quote.status).toBe("accepted");
    expect(() => quote.withdraw(NOW)).toThrow(QuoteRuleError);
    quote.supersede(NOW);
    expect(quote.snapshot()).toMatchObject({ status: "superseded", closedAt: NOW });
    const other = draft();
    other.withdraw(NOW);
    expect(other.status).toBe("withdrawn");
  });
});
