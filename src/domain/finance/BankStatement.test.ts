import { describe, expect, it } from "vitest";
import {
  parseStatement,
  parseStatementAmount,
  parseStatementDate,
  statementLineKey,
} from "./BankStatement.js";
import { FinanceRuleError } from "./Journal.js";

const options = { currency: "GHS", dayFirst: true };

describe("statement dates and amounts", () => {
  it.each([
    ["2026-10-05", "2026-10-05"],
    ["2026-10-05 14:22:01", "2026-10-05"],
    ["05/10/2026", "2026-10-05"],
    ["5-10-26", "2026-10-05"],
    ["05.10.2026 09:00", "2026-10-05"],
    ["05-Oct-2026", "2026-10-05"],
    ["5 October 2026", "2026-10-05"],
  ])("reads %s", (text, date) => {
    expect(parseStatementDate(text, true)).toBe(date);
  });

  it("reads the month first when told, and refuses what is not a date", () => {
    expect(parseStatementDate("10/05/2026", false)).toBe("2026-10-05");
    expect(parseStatementDate("31/02/2026", true)).toBeNull();
    expect(parseStatementDate("Balance", true)).toBeNull();
  });

  it.each([
    ["1,250.50", 125_050],
    ["(100.00)", -10_000],
    ["-5", -500],
    ["300.00 DR", -30_000],
    ["300.00CR", 30_000],
    ["GHS 20", 2_000],
    ["", null],
    ["-", null],
  ])("reads %s", (text, minor) => {
    expect(parseStatementAmount(text, "GHS")).toBe(minor);
  });

  it("refuses an amount that is not one", () => {
    expect(() => parseStatementAmount("n/a!", "GHS")).toThrow(FinanceRuleError);
    expect(() => parseStatementAmount("1.234", "GHS")).toThrow(FinanceRuleError);
  });
});

describe("parseStatement", () => {
  it("finds the header below the bank's lines and reads debit and credit columns", () => {
    const parsed = parseStatement(
      [
        ["Ecobank Ghana"],
        ["Account", "1441000123"],
        ["Value Date", "Narration", "Ref", "Debit", "Credit", "Balance"],
        ["", "Balance b/f", "", "", "", "1,000.00"],
        ["01/10/2026", "Transfer from Ama", "TX1", "", "200.00", "1,200.00"],
        ["02/10/2026", "Charges", "", "5.00", "", "1,195.00"],
        ["Total", "", "", "5.00", "200.00", ""],
      ],
      options,
    );
    expect(parsed.columns).toMatchObject({ date: "Value Date", description: "Narration" });
    expect(parsed.lines.map((l) => l.amountMinor)).toEqual([20_000, -500]);
    expect(parsed.lines[0]).toMatchObject({ row: 5, reference: "TX1", balanceMinor: 120_000 });
    expect(parsed.skipped).toBe(1);
    expect(parsed.errors).toEqual([{ row: 7, message: '"Total" is not a date' }]);
  });

  it("reads one signed amount, or an amount with a Dr/Cr column", () => {
    const signed = parseStatement(
      [
        ["Date", "Details", "Amount"],
        ["2026-10-01", "In", "50.00"],
        ["2026-10-02", "Out", "-20.00"],
      ],
      options,
    );
    expect(signed.lines.map((l) => l.amountMinor)).toEqual([5_000, -2_000]);
    const flagged = parseStatement(
      [
        ["Date", "Details", "Amount", "Dr/Cr"],
        ["2026-10-01", "In", "50.00", "CR"],
        ["2026-10-02", "Out", "20.00", "DR"],
      ],
      options,
    );
    expect(flagged.lines.map((l) => l.amountMinor)).toEqual([5_000, -2_000]);
  });

  it("puts a newest-first statement oldest first", () => {
    const parsed = parseStatement(
      [
        ["Date", "Amount", "Balance"],
        ["2026-10-03", "1.00", "3.00"],
        ["2026-10-01", "2.00", "2.00"],
      ],
      options,
    );
    expect(parsed.lines.map((l) => l.date)).toEqual(["2026-10-01", "2026-10-03"]);
  });

  it("takes columns named by the user and asks for them when it finds none", () => {
    const rows = [
      ["Posted", "Sum"],
      ["2026-10-01", "1.00"],
    ];
    expect(() => parseStatement(rows, options)).toThrow(FinanceRuleError);
    const parsed = parseStatement(rows, {
      ...options,
      columns: { date: "Posted", amount: "Sum" },
    });
    expect(parsed.lines).toHaveLength(1);
  });

  it("tells identical lines of a day apart by their occurrence", () => {
    const line = {
      row: 2,
      date: "2026-10-01",
      description: "POS",
      reference: null,
      amountMinor: 100,
      balanceMinor: null,
    };
    expect(statementLineKey(line, 0)).not.toBe(statementLineKey(line, 1));
    expect(statementLineKey({ ...line, row: 9 }, 0)).toBe(statementLineKey(line, 0));
  });
});
