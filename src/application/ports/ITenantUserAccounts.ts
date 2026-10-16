export type TenantUserAccount = Readonly<{
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: "invited" | "active" | "disabled";
  passwordHash: string | null;
  permissionVersion: number;
}>;

/** Tenant user credentials (the full user management API arrives in P1-5). */
export interface ITenantUserAccounts {
  lockById(id: string): Promise<TenantUserAccount | null>;
  /** Sets the password and makes an invited user active. */
  activate(id: string, passwordHash: string, now: Date): Promise<void>;
  recordLogin(id: string, now: Date): Promise<void>;
}
