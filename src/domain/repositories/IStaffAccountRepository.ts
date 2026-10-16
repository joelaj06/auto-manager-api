import type { StaffAccount } from "../entities/StaffAccount.js";

/** Platform staff accounts. Writes inside a platform unit of work. */
export interface IStaffAccountRepository {
  findById(id: string): Promise<StaffAccount | null>;
  findByEmail(email: string): Promise<StaffAccount | null>;
  /** Loads and locks the account until the unit of work ends (concurrent sign-in attempts). */
  lockById(id: string): Promise<StaffAccount | null>;
  /** Inserts or updates. */
  save(account: StaffAccount, invitedBy?: string | null): Promise<void>;
  list(): Promise<StaffAccount[]>;
}
