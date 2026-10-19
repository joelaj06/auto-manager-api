import { describe, expect, it } from "vitest";
import { CsvFormatError, parseCsv, toCsv } from "./csv.js";

describe("csv", () => {
  it("round-trips quotes, commas, line breaks and defused formulas", () => {
    const rows = [
      { plate: "GR 1234-21", notes: 'Say "hi", then\nleave', formula: "=SUM(A1)" },
      { plate: "AS 1-22", notes: "", formula: "-5" },
    ];
    const csv = toCsv(["plate", "notes", "formula"], rows);
    expect(csv).toContain("'=SUM(A1)");
    expect(parseCsv(`\uFEFF${csv}`)).toEqual(rows);
  });

  it("lower-cases headers, skips blank lines and fills missing cells", () => {
    expect(parseCsv("Plate_Number,Make\r\n\r\nGR 1-21\n")).toEqual([
      { plate_number: "GR 1-21", make: "" },
    ]);
  });

  it("refuses broken files", () => {
    expect(() => parseCsv("")).toThrow(CsvFormatError);
    expect(() => parseCsv('a,b\n"open')).toThrow(/not closed/);
    expect(() => parseCsv("a,a\n1,2")).toThrow(/twice/);
    expect(() => parseCsv("a\n1,2")).toThrow(/more cells/);
  });
});
