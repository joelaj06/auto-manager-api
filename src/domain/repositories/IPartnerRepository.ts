import type { Partner } from "../entities/Partner.js";

/** Reseller partners and their capability grants. Writes inside a platform unit of work. */
export interface IPartnerRepository {
  findById(id: string): Promise<Partner | null>;
  lockById(id: string): Promise<Partner | null>;
  findByReferralCode(code: string): Promise<Partner | null>;
  referralCodeTaken(code: string, exceptPartnerId?: string): Promise<boolean>;
  emailTaken(email: string, exceptPartnerId?: string): Promise<boolean>;
  /** Inserts or updates the partner and replaces its capability grants. */
  save(partner: Partner, actorId: string | null): Promise<void>;
}
