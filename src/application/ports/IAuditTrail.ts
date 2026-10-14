import type { AuditEntry } from "../dto/AuditEntry.js";

/** Append-only audit trail of the current tenant. Call inside the unit of work of the change. */
export interface IAuditTrail {
  /** Returns the id of the stored entry. */
  record(entry: AuditEntry): Promise<string>;
}
