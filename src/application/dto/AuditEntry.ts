export type AuditActorType = "user" | "platform_staff" | "system";

/** One entry of a tenant's audit trail. Secrets must be redacted from before/after. */
export type AuditEntry = Readonly<{
  actorType: AuditActorType;
  actorId?: string | null;
  /** Dotted verb, e.g. "vehicle.status_changed". */
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Readonly<Record<string, unknown>>;
}>;
