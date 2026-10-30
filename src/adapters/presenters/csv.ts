// Writing CSV is shared with the report files (infrastructure): see application/services/Csv.
import { FORMULA_START } from "../../application/services/Csv.js";
export { csvCell, toCsv } from "../../application/services/Csv.js";

export class CsvFormatError extends Error {
  readonly code = "INVALID_CSV";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Parses CSV (RFC 4180: quoted cells, doubled quotes, CRLF or LF) with a header row into
 * records keyed by the lower-cased header. Blank lines are skipped; a leading byte-order mark
 * and the `'` our exports put before formula characters are removed.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseRows(text.replace(/^\uFEFF/, ""));
  const header = rows.shift();
  if (header === undefined) throw new CsvFormatError("The file is empty");
  const columns = header.map((h) => h.trim().toLowerCase());
  if (new Set(columns).size !== columns.length)
    throw new CsvFormatError("A column appears twice in the header");
  return rows.map((cells, index) => {
    if (cells.length > columns.length)
      throw new CsvFormatError(`Line ${index + 2} has more cells than the header`);
    return Object.fromEntries(columns.map((c, i) => [c, unescapeFormula(cells[i] ?? "")]));
  });
}

function unescapeFormula(cell: string): string {
  return cell.startsWith("'") && FORMULA_START.has(cell.charAt(1)) ? cell.slice(1) : cell;
}

function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(cell);
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
    cell = "";
  };
  while (i < text.length) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      endRow();
    } else cell += char;
    i += 1;
  }
  if (quoted) throw new CsvFormatError("A quoted cell is not closed");
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}
