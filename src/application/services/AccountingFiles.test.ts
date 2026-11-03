import { describe, expect, it } from "vitest";
import type { ExportLine } from "../../domain/finance/AccountingExport.js";
import { accountingFile } from "./AccountingFiles.js";

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
const options = { currency: "GHS", external: () => null, xeroTaxRate: "Tax Exempt" };

describe("accountingFile", () => {
  it("writes QuickBooks' columns with debits and credits apart and the mapped name", () => {
    const file = accountingFile("quickbooks", lines.slice(0, 2), {
      ...options,
      external: (id) => (id === "bank" ? "Ecobank Current" : null),
    });
    const rows = file.trim().split("\r\n");
    expect(rows[0]).toBe(
      "Journal No,Journal Date,Account Name,Debits,Credits,Description,Name,Location",
    );
    expect(rows[1]).toBe(
      'JRN-1,05/10/2026,Ecobank Current,100.50,,"Receipt RCT-1 from Ama, Osu",,Accra',
    );
    expect(rows[2]).toContain("Credit,,100.50,");
  });

  it("writes Xero's signed amounts unquoted, with the account code", () => {
    const file = accountingFile("xero", lines.slice(0, 2), options);
    const rows = file.trim().split("\r\n");
    expect(rows[0]).toBe("*Narration,*Date,Description,*AccountCode,*TaxRate,*Amount");
    expect(rows[1]!.endsWith(",1020,Tax Exempt,100.50")).toBe(true);
    expect(rows[2]!.endsWith(",2100,Tax Exempt,-100.50")).toBe(true);
  });

  it("defuses text that a spreadsheet would run, in every format", () => {
    const risky = [line({ memo: "=HYPERLINK(1)", debitMinor: 100 })];
    for (const format of ["quickbooks", "xero", "csv"] as const)
      expect(accountingFile(format, risky, options)).toContain("'=HYPERLINK(1)");
  });
});
