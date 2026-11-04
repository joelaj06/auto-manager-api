export type TenantCredentialStatus = "enabling" | "active" | "disabling";

export type TenantCredentialRecord = Readonly<{
  tenantId: string;
  roleName: string;
  sealedPassword: string;
  version: number;
  status: TenantCredentialStatus;
  rotatedAt: Date;
  createdAt: Date;
}>;

export interface ITenantDatabaseCredentials {
  find(tenantId: string): Promise<TenantCredentialRecord | null>;
  save(
    record: Readonly<{
      tenantId: string;
      roleName: string;
      sealedPassword: string;
      status: TenantCredentialStatus;
    }>,
    now: Date,
  ): Promise<void>;
  setStatus(tenantId: string, status: TenantCredentialStatus): Promise<void>;
  remove(tenantId: string): Promise<void>;
}

/** The tenant's own PostgreSQL login on a cluster (decision 532). */
export interface ITenantDatabaseRoles {
  roleNameOf(tenantId: string): string;
  /** Creates the login, or sets its password, and lets it connect to the tenant's database. */
  ensure(tenantId: string, clusterId: string, password: string): Promise<void>;
  /** Closes the database to the shared app login and ends its sessions there. */
  closeShared(tenantId: string, clusterId: string): Promise<void>;
  /** Opens the database to the shared app login again. */
  openShared(tenantId: string, clusterId: string): Promise<void>;
  /** Ends the login's sessions and removes it. Nothing happens when it does not exist. */
  drop(tenantId: string, clusterId: string): Promise<void>;
}

/** Forgets what a process cached about a tenant's login. */
export interface ITenantLoginCache {
  forget(tenantId: string): void;
}
