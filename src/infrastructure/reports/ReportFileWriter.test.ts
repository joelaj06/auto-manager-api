import { describe, expect, it } from "vitest";
import type { ReportTable } from "../../domain/reporting/Report.js";
import { sniffContentType } from "../../domain/files/FileKinds.js";
import { unzip } from "../../testing/unzip.js";
import { ReportFileWriter } from "./ReportFileWriter.js";

const TABLE: ReportTable = {
  title: "Dealer gross profit",
  subtitle: "2026-10-01 to 2026-10-30",
  currency: "GHS",
  columns: [
    { key: "deal", header: "Deal", type: "text" },
    { key: "note", header: "Note", type: "text" },
    { key: "revenue", header: "Revenue", type: "money" },
    { key: "margin", header: "Margin", type: "percent" },
    { key: "units", header: "Units", type: "number" },
  ],
  rows: [
    {
      deal: "DEAL-2026-000001",
      note: '=HYPERLINK("x")',
      revenue: 6_000_000,
      margin: 12.5,
      units: 1,
    },
    { deal: "DEAL-2026-000002", note: "Kofi & Ama <VIP>", revenue: -150, margin: null, units: 2 },
  ],
  totals: { deal: "Total", note: null, revenue: 5_999_850, margin: 12.4, units: 3 },
  summary: [{ label: "Units sold", value: "2" }],
};

describe("report file writer", () => {
  const writer = new ReportFileWriter();

  it("writes CSV with a byte-order mark, decimal money and formulas defused", () => {
    const csv = writer.csv(TABLE);
    expect(sniffContentType(csv.subarray(0, 16))).toBe("text/csv");
    expect(csv.subarray(3).toString("utf8").split("\r\n")).toEqual([
      "Deal,Note,Revenue (GHS),Margin,Units",
      `DEAL-2026-000001,"'=HYPERLINK(""x"")",60000.00,12.5,1`,
      "DEAL-2026-000002,Kofi & Ama <VIP>,-1.50,,2",
      "Total,,59998.50,12.4,3",
      "",
    ]);
  });

  it("writes an XLSX package with the title, summary, header, rows and a bold totals row", () => {
    const xlsx = writer.xlsx(TABLE);
    expect(sniffContentType(xlsx.subarray(0, 16))).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    const parts = unzip(xlsx);
    expect([...parts.keys()].sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    const sheet = parts.get("xl/worksheets/sheet1.xml")!.toString("utf8");
    expect(sheet).toContain('<t xml:space="preserve">Dealer gross profit</t>');
    expect(sheet).toContain('<t xml:space="preserve">Units sold</t>');
    // Header row 5 (title, period, one summary line, a blank row), frozen below it.
    expect(sheet).toContain('<pane ySplit="5" topLeftCell="A6"');
    expect(sheet).toContain('<t xml:space="preserve">Revenue (GHS)</t>');
    expect(sheet).toContain('<c r="C6" s="2"><v>60000.00</v></c>');
    expect(sheet).toContain('<c r="D6" s="4"><v>12.5</v></c>');
    expect(sheet).toContain('<c r="C7" s="2"><v>-1.50</v></c>');
    expect(sheet).toContain("Kofi &amp; Ama &lt;VIP&gt;");
    // Text stays text: no formula is written.
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain('<c r="A8" t="inlineStr" s="1">');
    expect(sheet).toContain('<c r="C8" s="3"><v>59998.50</v></c>');
  });
});
