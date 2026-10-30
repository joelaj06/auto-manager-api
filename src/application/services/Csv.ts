/** Leading characters spreadsheets treat as a formula (CSV injection). */
export const FORMULA_START: ReadonlySet<string> = new Set(["=", "+", "-", "@", "\t", "\r"]);

/** One CSV cell, quoted when needed and defused against formula injection. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : JSON.stringify(value);
  if (FORMULA_START.has(text.charAt(0))) text = `'${text}`;
  return text.includes(",") || text.includes('"') || text.includes("\n") || text.includes("\r")
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

/** A table as CSV (RFC 4180, CRLF line ends), safe to open in a spreadsheet. */
export function toCsv(
  columns: readonly string[],
  rows: readonly Readonly<Record<string, unknown>>[],
): string {
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}
