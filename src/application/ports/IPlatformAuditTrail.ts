import type { Paged } from "../../domain/value-objects/Paged.js";
export type PlatformAuditEntry = Readonly<{
  actorType: "platform_staff" | "partner" | "system";
  actorId?: string | null;
  /** Dotted verb, e.g. "staff.invited". */
  action: string;
  entityType: string;
  entityId?: string | null;
  targetTenantId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type PlatformAuditRecord = PlatformAuditEntry & Readonly<{ id: string; occurredAt: Date }>;

export type PlatformAuditQuery = Readonly<{
  actorId?: string;
  action?: string;
  targetTenantId?: string;
  entityType?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
  limit: number;
  offset?: number;
}>;

/** A walk over the whole log: stays right while new entries arrive. */
export type PlatformAuditScan = PlatformAuditQuery &
  Readonly<{
    /** Entries strictly older than this id. */
    before?: string;
  }>;

/** The immutable platform audit log (docs/27 §2). */
export interface IPlatformAuditTrail {
  record(entry: PlatformAuditEntry): Promise<string>;
  page(query: PlatformAuditQuery): Promise<Paged<PlatformAuditRecord>>;
  search(query: PlatformAuditScan): Promise<PlatformAuditRecord[]>;
}
