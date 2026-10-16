export type StaffInvitation = Readonly<{ id: string; userId: string; expiresAt: Date }>;

/** One-time invitation links; only the SHA-256 of the token is stored. */
export interface IStaffInvitations {
  create(params: {
    id: string;
    userId: string;
    tokenHash: string;
    invitedBy: string | null;
    expiresAt: Date;
  }): Promise<void>;
  /** An unexpired, unaccepted, unrevoked invitation, locked until the unit of work ends. */
  lockValid(tokenHash: string, now: Date): Promise<StaffInvitation | null>;
  markAccepted(id: string, now: Date): Promise<void>;
  /** Revokes the user's open invitations (before re-inviting). */
  revokeOpen(userId: string, now: Date): Promise<void>;
}
