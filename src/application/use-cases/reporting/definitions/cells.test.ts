import { describe, expect, it } from "vitest";
import { percent, share, totalsRow, vehicleName, words } from "./cells.js";

describe("report cells", () => {
  it("writes shares to one decimal and leaves an empty whole out", () => {
    expect(share(1, 3)).toBe(33.3);
    expect(share(25_000, 75_000)).toBe(33.3);
    expect(share(5, 0)).toBeNull();
    expect(percent("12.5")).toBe(12.5);
    expect(percent(null)).toBeNull();
  });

  it("names vehicles and statuses for people", () => {
    expect(vehicleName({ code: "V-001", plateNumber: "GR 1234-26" })).toBe("V-001 · GR 1234-26");
    expect(vehicleName({ code: "V-002", plateNumber: null })).toBe("V-002");
    expect(words("in_arrears")).toBe("in arrears");
  });

  it("builds a totals row with the label first and the rest empty", () => {
    expect(
      totalsRow(["date", "entry", "debit", "credit"], "Total", { debit: 10, credit: 10 }),
    ).toEqual({ date: "Total", entry: null, debit: 10, credit: 10 });
  });
});
