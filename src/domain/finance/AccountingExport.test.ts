import { describe, expect, it } from "vitest";
import { summarise, type ExportLine } from "./AccountingExport.js";

const line = (over: Partial<ExportLine>): ExportLine => ({
  journalNumber: "JRN-1",
  date: "2026-10-05",
  description: "Receipt RCT-1 from Ama, Osu",
  sourceType: "payment",
  accountId: "bank",
  accountCode: "1020",
  accountName: "Bank",
  debitMinor: 0,
  creditMinor: 0,
  branch: "Accra",
  vehicle: null,
  partyType: null,
  partyName: null,
  memo: null,
  ...over,
});
const lines = [
  line({ debitMinor: 10_050 }),
  line({ accountId: "credit", accountCode: "2100", accountName: "Credit", creditMinor: 10_050 }),
  line({ journalNumber: "JRN-2", date: "2026-10-20", creditMinor: 2_000 }),
  line({
    journalNumber: "JRN-2",
    date: "2026-10-20",
    accountId: "credit",
    accountCode: "2100",
    accountName: "Credit",
    debitMinor: 2_000,
  }),
];

describe("accounting export", () => {
  it("nets accounts per month, dated on the period's last day used, and stays balanced", () => {
    const month = summarise(lines, "month");
    expect(month).toHaveLength(2);
    expect(month[0]).toMatchObject({
      journalNumber: "AF-2026-10",
      date: "2026-10-20",
      accountCode: "1020",
      debitMinor: 8_050,
      creditMinor: 0,
      partyName: null,
    });
    expect(month[1]).toMatchObject({ debitMinor: 0, creditMinor: 8_050 });
    expect(summarise(lines, "day")).toHaveLength(4);
    expect(summarise(lines, "entry")).toEqual(lines);
  });

  it("leaves out an account netting to nothing", () => {
    const pair = lines.slice(0, 2);
    const undone = [
      { ...pair[0]!, debitMinor: 0, creditMinor: 10_050 },
      { ...pair[1]!, debitMinor: 10_050, creditMinor: 0 },
    ];
    expect(summarise([...pair, ...undone], "day")).toEqual([]);
  });
});
