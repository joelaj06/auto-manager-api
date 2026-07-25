// entities/Subscription.ts
export class ISubscription {
  constructor(
    public readonly _id?: string,
    public readonly tenantId?: string,
    public readonly plan?: "basic" | "premium" | "enterprise",
    public readonly status?: "trialing" | "active" | "past_due" | "canceled",
    public readonly startDate?: Date,
    public readonly currentPeriodEnd?: Date,
    public readonly cancelAtPeriodEnd?: boolean,
    public readonly externalProviderId?: string, // Stripe/Paystack subscription id — null until payment integration lands
    public readonly createdAt?: Date,
    public readonly updatedAt?: Date,
  ) {}
}
