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
  from?: Date;
  to?: Date;
  limit: number;
  /** Keyset cursor: entries strictly older than this id. */
  before?: string;
}>;

/** The immutable platform audit log (docs/27 §2). */
export interface IPlatformAuditTrail {
  record(entry: PlatformAuditEntry): Promise<string>;
  search(query: PlatformAuditQuery): Promise<PlatformAuditRecord[]>;
}
