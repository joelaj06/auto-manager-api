/** One-time "set your password" links for tenant users (tenant database). */
export interface IUserInvitations {
  /** Creates a new link for the user and revokes their open ones. */
  create(params: { userId: string; tokenHash: string; expiresAt: Date }): Promise<string>;
  lockValid(tokenHash: string, now: Date): Promise<Readonly<{ id: string; userId: string }> | null>;
  markAccepted(id: string, now: Date): Promise<void>;
}
