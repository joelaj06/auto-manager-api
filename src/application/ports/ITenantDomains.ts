import type { DomainStatus } from "../../domain/console/CustomDomains.js";

export type TenantDomainRecord = Readonly<{
  id: string;
  tenantId: string;
  domain: string;
  status: DomainStatus;
  verificationToken: string;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
  failedChecks: number;
  createdAt: Date;
}>;

export interface ITenantDomains {
  create(
    domain: Readonly<{
      tenantId: string;
      domain: string;
      verificationToken: string;
      createdBy: string;
    }>,
  ): Promise<string>;
  find(id: string): Promise<TenantDomainRecord | null>;
  findByDomain(domain: string): Promise<TenantDomainRecord | null>;
  ofTenant(tenantId: string): Promise<TenantDomainRecord[]>;
  /** Domains checked by the daily sweep: active and suspended ones. */
  verified(): Promise<TenantDomainRecord[]>;
  /** Every active domain with its tenant's slug. */
  active(): Promise<ReadonlyArray<Readonly<{ domain: string; slug: string }>>>;
  update(
    id: string,
    changes: Readonly<{
      status: DomainStatus;
      verifiedAt?: Date;
      lastCheckedAt: Date;
      lastError: string | null;
      failedChecks: number;
    }>,
  ): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Which business an incoming host name belongs to (cached). */
export interface ITenantDomainLookup {
  slugOf(hostname: string): Promise<string | null>;
  forget(): void;
}

export interface IDnsResolver {
  txt(name: string): Promise<string[]>;
  cnames(name: string): Promise<string[]>;
  addresses(name: string): Promise<string[]>;
}
