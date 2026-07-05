export class ITenant {
  constructor(
    public readonly _id?: string,
    public readonly name?: string,
    public readonly slug?: string,
    public readonly subdomain?: string,
    public readonly domains?: string[],
    public readonly databaseName?: string,
    public readonly databaseUri?: string,
    public readonly status?: string,
    public readonly subscriptionStatus?: string,
    public readonly subscriptionExpiresAt?: Date,
    public readonly isDeleted?: boolean,
    public readonly createdAt?: Date,
    public readonly updatedAt?: Date,
  ) {}
}

export enum TenantStatus {
  ACTIVE = "active",
  INACTIVE = "inactive",
  SUSPENDED = "suspended",
  ARCHIVED = "archived",
}

export enum SubscriptionStatus {
  ACTIVE = "active",
  EXPIRED = "expired",
  PENDING = "pending",
}
