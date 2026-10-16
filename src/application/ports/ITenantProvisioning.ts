export type ProvisioningStep =
  | "registered"
  | "database_created"
  | "schema_migrated"
  | "seeded"
  | "directory_updated"
  | "welcomed"
  | "completed";

export const PROVISIONING_STEPS: readonly ProvisioningStep[] = [
  "registered",
  "database_created",
  "schema_migrated",
  "seeded",
  "directory_updated",
  "welcomed",
  "completed",
];

export type ProvisioningRecord = Readonly<{
  tenantId: string;
  slug: string;
  name: string;
  timezone: string;
  tenantStatus: string;
  status: "running" | "failed" | "completed";
  step: ProvisioningStep;
  attempts: number;
  lastError: string | null;
  startedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  application: Readonly<{
    id: string;
    contactName: string;
    contactEmail: string;
    contactPhone: string;
    country: string;
    tin: string | null;
    registrationNumber: string | null;
    trialDays: number;
  }>;
}>;

/** The provisioning saga's state in the platform database (tenants + tenant_provisioning). */
export interface ITenantProvisioning {
  /** Reserves the slug: a `provisioning` tenant row and its saga record. */
  register(params: {
    tenantId: string;
    slug: string;
    name: string;
    timezone: string;
    applicationId: string;
  }): Promise<void>;
  find(tenantId: string): Promise<ProvisioningRecord | null>;
  /** A new attempt: status running, attempts + 1, tenant back to `provisioning`. */
  begin(tenantId: string): Promise<void>;
  advance(tenantId: string, step: ProvisioningStep): Promise<void>;
  /** Records the name of the tenant's database (once it exists). */
  setDatabaseName(tenantId: string, databaseName: string): Promise<void>;
  /** Records the error; the tenant becomes `provisioning_failed` (retryable). */
  fail(tenantId: string, error: string): Promise<void>;
  /** The tenant becomes `trialing`. */
  complete(
    tenantId: string,
    params: { trialEndsAt: Date; catalogueVersion: number },
  ): Promise<void>;
  /** Running sagas with no progress since `before` (lost jobs). */
  stalled(before: Date): Promise<string[]>;
  /** Provisioned tenants whose catalogue version is older than `version`. */
  behindCatalogue(version: number): Promise<string[]>;
  setCatalogueVersion(tenantId: string, version: number): Promise<void>;
}
