import type { DemoPurpose, SampleDataStatus } from "../../domain/console/DemoTenants.js";

export type BusinessType = "fleet" | "rental" | "dealer" | "mixed";

export type DemoTenant = Readonly<{
  tenantId: string;
  slug: string;
  name: string;
  tenantStatus: string;
  businessType: BusinessType;
  clusterId: string;
  hasDatabase: boolean;
  provisioning: string | null;
  purpose: DemoPurpose;
  prospect: string | null;
  contactName: string;
  contactEmail: string;
  sampleData: SampleDataStatus;
  sampleReport: Readonly<Record<string, unknown>>;
  sampleError: string | null;
  expiresAt: Date;
  extensions: number;
  expiredAt: Date | null;
  purgedAt: Date | null;
  createdBy: string;
  createdAt: Date;
}>;

export type NewDemo = Readonly<{
  tenantId: string;
  slug: string;
  name: string;
  businessType: BusinessType;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  purpose: DemoPurpose;
  prospect: string | null;
  trialDays: number;
  expiresAt: Date;
  sampleData: boolean;
  createdBy: string;
}>;

export type DemoChanges = Readonly<{
  sampleData?: SampleDataStatus;
  sampleReport?: Readonly<Record<string, unknown>>;
  sampleError?: string | null;
  expiresAt?: Date;
  extensions?: number;
  expiredAt?: Date | null;
  purgedAt?: Date;
}>;

/** Demo and sandbox tenants (platform database, docs/27 §5.2). */
export interface IDemoTenants {
  slugTaken(slug: string): Promise<boolean>;
  liveCount(): Promise<number>;
  /**
   * The demo's application, approved as assisted by the staff member, marked demo, and its demo
   * record; the tenant row itself is registered by provisioning.
   */
  createApplication(demo: NewDemo): Promise<string>;
  markDemo(demo: NewDemo): Promise<void>;
  find(tenantId: string): Promise<DemoTenant | null>;
  list(filter: Readonly<{ live?: boolean; limit: number }>): Promise<DemoTenant[]>;
  update(tenantId: string, changes: DemoChanges): Promise<void>;
  /**
   * Demos past their end not expired yet, expired ones due their purge, and provisioned ones
   * whose sample data is still to do (seeding interrupted, or never queued).
   */
  due(
    now: Date,
    purgeBefore: Date,
  ): Promise<Readonly<{ expire: string[]; purge: string[]; seed: string[] }>>;
  /** The purged demo has no database any more. */
  forgetDatabase(tenantId: string): Promise<void>;
}

/** Fills a new demo tenant with sample data, section by section (resumable). */
export interface IDemoSampleData {
  seed(
    target: Readonly<{ tenantId: string; slug: string; businessType: BusinessType }>,
    done: Readonly<Record<string, unknown>>,
    progress: (report: Readonly<Record<string, unknown>>) => Promise<void>,
  ): Promise<Readonly<Record<string, unknown>>>;
}

/**
 * The user a demo's sample data is entered as (in the demo's own database): active with the
 * owner role but no password anyone knows, and disabled once the sample data is in. The owner
 * stays invited until the contact sets their password.
 */
export interface IDemoSampleUser {
  open(): Promise<Readonly<{ id: string; permissionVersion: number }>>;
  close(userId: string): Promise<void>;
}
