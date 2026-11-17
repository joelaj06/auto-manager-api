import { describe, expect, it } from "vitest";
import { listTotals, pageHeaders, PAGE_HEADERS, totalsHeaderNames } from "./pageHeaders.js";

describe("pageHeaders", () => {
  it("names the total, page and page size as text", () => {
    expect(pageHeaders({ total: 123, page: 3, pageSize: 25 })).toEqual({
      "X-Total-Count": "123",
      "X-Page": "3",
      "X-Page-Size": "25",
    });
  });

  it("gives a header for every name the browser is allowed to read", () => {
    expect(Object.keys(pageHeaders({ total: 0, page: 1, pageSize: 20 })).sort()).toEqual(
      [...PAGE_HEADERS].sort(),
    );
  });
});

describe("money totals", () => {
  const totals = listTotals({
    amount: "invoice total",
    statuses: ["draft", "partially_paid", "paid", "void"],
    measures: { paid: "paid", outstanding: "left to pay" },
  });

  it("gives the amount, each status and each measure in minor units, zero when nothing adds up", () => {
    const headers = pageHeaders(
      {
        total: 3,
        page: 1,
        pageSize: 1,
        totals: {
          currency: "GHS",
          amount: 30000,
          byStatus: { draft: 10000, paid: 20000 },
          measures: { paid: 20000 },
        },
      },
      totals,
    );
    expect(headers).toEqual({
      "X-Total-Count": "3",
      "X-Page": "1",
      "X-Page-Size": "1",
      "X-Currency": "GHS",
      "X-Total-Amount": "30000",
      "X-Total-Draft": "10000",
      "X-Total-Partially-Paid": "0",
      "X-Total-Paid": "20000",
      "X-Total-Void": "0",
      "X-Total-Amount-Paid": "20000",
      "X-Total-Amount-Outstanding": "0",
    });
    expect(Object.keys(headers).slice(3)).toEqual(totalsHeaderNames(totals));
  });

  it("gives no amount or statuses for a list of measures only", () => {
    expect(
      totalsHeaderNames(listTotals({ measures: { debit: "debits", credit: "credits" } })),
    ).toEqual(["X-Currency", "X-Total-Amount-Debit", "X-Total-Amount-Credit"]);
  });

  it("refuses a list of money paged without its totals", () => {
    expect(() => pageHeaders({ total: 0, page: 1, pageSize: 1 }, totals)).toThrow(/totals/);
  });

  it("refuses totals that would share a header", () => {
    expect(() => listTotals({ amount: "x", statuses: ["count"] })).toThrow(/X-Total-Count/i);
    expect(() => listTotals({ amount: "x", statuses: ["paid_up", "paid-up"] })).toThrow(/share/);
  });
});
