import type { ErasureSubject } from "../../domain/console/ColdArchive.js";

/** The tenant database to work on: the tenant's own, or a restored copy of it. */
export type ErasureTarget = Readonly<{
  tenantId: string;
  /** Another database (a restored backup) on a cluster; the tenant's own by default. */
  database?: Readonly<{ clusterId: string; name: string }>;
}>;

export type ErasureSubjectRef = Readonly<{ type: ErasureSubject; id: string }>;

export type SubjectPreview = Readonly<{
  found: boolean;
  /** The record's code or number, kept after erasure. */
  reference: string | null;
  /** The name as it is now, for the approver to check (never stored by the platform). */
  name: string | null;
  /** Why it cannot be erased (a tenant owner). */
  blockedBy: string | null;
  /** Related records whose personal data goes too. */
  related: Readonly<Record<string, number>>;
}>;

export type ErasureReport = Readonly<{
  /** Rows changed per table. */
  tables: Readonly<Record<string, number>>;
  filesRemoved: number;
  /** Platform emails to the person redacted. */
  platformEmails: number;
}>;

/**
 * Anonymises a person's personal data in a tenant's database (decision 498): names, phone
 * numbers, emails, addresses, ID and licence numbers replaced by stand-ins derived from the
 * record's id, their identity documents removed from storage, the audit trail's copies redacted.
 * Applying it again gives the same result.
 */
export interface IPersonalDataEraser {
  preview(target: ErasureTarget, subject: ErasureSubjectRef): Promise<SubjectPreview>;
  erase(target: ErasureTarget, subject: ErasureSubjectRef): Promise<ErasureReport>;
}
