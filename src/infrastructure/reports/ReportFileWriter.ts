import { csvCell } from "../../application/services/Csv.js";
import type { IReportFileWriter } from "../../application/ports/IReportJobs.js";
import { Money } from "../../domain/money/Money.js";
import type { Cell, ReportColumn, ReportRow, ReportTable } from "../../domain/reporting/Report.js";
import { ZipWriter } from "../exports/ZipWriter.js";

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Money columns name their currency in the header; the cells are plain decimals. */
const header = (c: ReportColumn, currency: string) =>
  c.type === "money" ? `${c.header} (${currency})` : c.header;

/** A cell as a plain value: money in major units ("1250.50"), the rest as it is. */
function plain(c: ReportColumn, value: Cell, currency: string): string | number | null {
  if (value === null || typeof value === "string") return value;
  return c.type === "money" ? Money.ofMinor(value, currency).toDecimalString() : value;
}

/**
 * Report tables as spreadsheet files (decision 465): CSV is the table alone (header, rows, the
 * totals row), RFC 4180 with CRLF and formula injection defused, in UTF-8 with a byte-order mark;
 * XLSX is one sheet with the title, the summary, a bold header and totals row, money as numbers
 * with two decimals and percentages as numbers shown with %, written as a minimal OOXML package.
 */
export class ReportFileWriter implements IReportFileWriter {
  csv(table: ReportTable): Buffer {
    const line = (cells: readonly unknown[]) => cells.map(csvCell).join(",");
    // Numbers are written as they are (a minus sign is not a formula); text is defused.
    const row = (r: ReportRow) =>
      table.columns
        .map((c) => {
          const raw = r[c.key] ?? null;
          const value = plain(c, raw, table.currency);
          return typeof raw === "number" ? String(value) : csvCell(value);
        })
        .join(",");
    const lines = [
      line(table.columns.map((c) => header(c, table.currency))),
      ...table.rows.map(row),
      ...(table.totals === null ? [] : [row(table.totals)]),
    ];
    return Buffer.concat([BOM, Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8")]);
  }

  xlsx(table: ReportTable): Buffer {
    const zip = new ZipWriter();
    zip.add("[Content_Types].xml", xml(CONTENT_TYPES));
    zip.add("_rels/.rels", xml(ROOT_RELS));
    zip.add("xl/workbook.xml", xml(WORKBOOK));
    zip.add("xl/_rels/workbook.xml.rels", xml(WORKBOOK_RELS));
    zip.add("xl/styles.xml", xml(STYLES));
    zip.add("xl/worksheets/sheet1.xml", xml(sheet(table)));
    return zip.finish();
  }
}

// --- the sheet ---

/** Cell styles (indexes into `cellXfs` below). */
const STYLE = { text: 0, bold: 1, money: 2, boldMoney: 3, percent: 4, boldPercent: 5 } as const;

function sheet(table: ReportTable): string {
  const rows: string[] = [];
  const widths = table.columns.map((c) => header(c, table.currency).length);
  let r = 0;
  const text = (ref: string, value: string, style: number = STYLE.text) =>
    `<c r="${ref}" t="inlineStr"${style === 0 ? "" : ` s="${style}"`}><is><t xml:space="preserve">${escape(value)}</t></is></c>`;
  const number = (ref: string, value: string | number, style: number) =>
    `<c r="${ref}"${style === 0 ? "" : ` s="${style}"`}><v>${value}</v></c>`;
  const push = (cells: string[]) => {
    r += 1;
    rows.push(`<row r="${r}">${cells.join("")}</row>`);
  };
  const tableRow = (row: ReportRow, bold: boolean) => {
    const at = r + 1;
    push(
      table.columns.map((c, i) => {
        const ref = `${column(i)}${at}`;
        const raw = row[c.key] ?? null;
        if (raw === null) return "";
        const value = plain(c, raw, table.currency)!;
        widths[i] = Math.max(widths[i]!, String(value).length + (c.type === "money" ? 3 : 0));
        if (typeof raw === "string") return text(ref, raw, bold ? STYLE.bold : STYLE.text);
        const style =
          c.type === "money"
            ? bold
              ? STYLE.boldMoney
              : STYLE.money
            : c.type === "percent"
              ? bold
                ? STYLE.boldPercent
                : STYLE.percent
              : bold
                ? STYLE.bold
                : STYLE.text;
        return number(ref, value, style);
      }),
    );
  };

  push([text("A1", table.title, STYLE.bold)]);
  if (table.subtitle !== null) push([text(`A${r + 1}`, table.subtitle)]);
  for (const s of table.summary) push([text(`A${r + 1}`, s.label), text(`B${r + 1}`, s.value)]);
  push([]);
  const headerRow = r + 1;
  push(
    table.columns.map((c, i) =>
      text(`${column(i)}${headerRow}`, header(c, table.currency), STYLE.bold),
    ),
  );
  for (const row of table.rows) tableRow(row, false);
  if (table.totals !== null) tableRow(table.totals, true);

  const cols = widths
    .map(
      (w, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(8, w + 2))}" customWidth="1"/>`,
    )
    .join("");
  return (
    `<worksheet xmlns="${MAIN}">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<cols>${cols}</cols><sheetData>${rows.join("")}</sheetData></worksheet>`
  );
}

/** A, B … Z, AA … (zero-based). */
function column(index: number): string {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** XML text: the five entities escaped, characters XML cannot hold dropped. */
function escape(value: string): string {
  return value
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const xml = (body: string) =>
  Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`, "utf8");

// --- the fixed parts of the package ---

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const OOXML = "application/vnd.openxmlformats-officedocument.spreadsheetml";

const CONTENT_TYPES =
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="${OOXML}.sheet.main+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${OOXML}.worksheet+xml"/>` +
  `<Override PartName="/xl/styles.xml" ContentType="${OOXML}.styles+xml"/>` +
  `</Types>`;

const ROOT_RELS =
  `<Relationships xmlns="${PKG_REL}">` +
  `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

const WORKBOOK =
  `<workbook xmlns="${MAIN}" xmlns:r="${REL}">` +
  `<sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets></workbook>`;

const WORKBOOK_RELS =
  `<Relationships xmlns="${PKG_REL}">` +
  `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/>` +
  `</Relationships>`;

/** Plain and bold text, money with two decimals and grouping, percentages to one decimal. */
const STYLES =
  `<styleSheet xmlns="${MAIN}">` +
  `<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="0.0&quot;%&quot;"/></numFmts>` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="6">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>` +
  `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="165" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;
