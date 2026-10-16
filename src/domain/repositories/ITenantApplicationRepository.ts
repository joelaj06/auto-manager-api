import type { ApplicationStatus, TenantApplication } from "../entities/TenantApplication.js";

export type ApplicationListQuery = Readonly<{
  status?: ApplicationStatus;
  /** Matches business name, slug, contact email or phone. */
  search?: string;
  assignedTo?: string;
  limit: number;
  /** Keyset cursor: applications created before this id. */
  before?: string;
}>;

/** Tenant applications (platform database). Writes inside a platform unit of work. */
export interface ITenantApplicationRepository {
  findById(id: string): Promise<TenantApplication | null>;
  lockById(id: string): Promise<TenantApplication | null>;
  save(application: TenantApplication): Promise<void>;
  /** Replaces the applicant's private-link token hash (a new link was emailed). */
  rotateAccessToken(id: string, tokenHash: string): Promise<void>;
  list(query: ApplicationListQuery): Promise<TenantApplication[]>;
}
