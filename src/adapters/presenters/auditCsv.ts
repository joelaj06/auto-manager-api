import type { PlatformAuditRecord } from "../../application/ports/IPlatformAuditTrail.js";

const COLUMNS = [
  "occurredAt",
  "id",
  "actorType",
  "actorId",
  "action",
  "entityType",
  "entityId",
  "targetTenantId",
  "reason",
  "requestId",
  "ip",
  "before",
  "after",
  "metadata",
] as const;

/** Leading characters spreadsheets treat as a formula (CSV injection). */
const FORMULA_START = new Set(["=", "+", "-", "@", "\t", "\r"]);

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  if (FORMULA_START.has(text.charAt(0))) text = `'${text}`;
  return text.includes(",") || text.includes('"') || text.includes("\n") || text.includes("\r")
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

/** The audit log as CSV (RFC 4180, CRLF line ends), safe to open in a spreadsheet. */
export function auditCsv(entries: readonly PlatformAuditRecord[]): string {
  const lines = [COLUMNS.join(",")];
  for (const entry of entries) lines.push(COLUMNS.map((column) => cell(entry[column])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}
