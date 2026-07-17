export class IAuditLog {
  constructor(
    public readonly _id?: string,
    public readonly tenantId?: string,
    public readonly action?: string, // "tenant.created" | "tenant.suspended" | etc.
    public readonly actorId?: string, // admin user id who triggered it, if any
    public readonly metadata?: Record<string, unknown>,
    public readonly createdAt?: Date,
  ) {}
}
