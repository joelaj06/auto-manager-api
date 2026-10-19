import type { PlatformAuditRecord } from "../../application/ports/IPlatformAuditTrail.js";
import { toCsv } from "./csv.js";

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

/** The audit log as CSV (RFC 4180, CRLF line ends), safe to open in a spreadsheet. */
export function auditCsv(entries: readonly PlatformAuditRecord[]): string {
  return toCsv(COLUMNS, entries);
}
