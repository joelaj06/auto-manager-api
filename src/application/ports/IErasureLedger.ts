import type { ErasureSubject } from "../../domain/console/ColdArchive.js";
import type { ErasureReport } from "./IPersonalDataEraser.js";

export type ErasureEntry = Readonly<{
  id: string;
  tenantId: string;
  subjectType: ErasureSubject;
  subjectId: string;
  requestId: string | null;
  reason: string;
  approvalId: string | null;
  requestedBy: string;
  approvedBy: string | null;
  status: "pending" | "applied";
  report: Partial<ErasureReport>;
  error: string | null;
  createdAt: Date;
  appliedAt: Date | null;
  reapplied: number;
  lastReappliedAt: Date | null;
}>;

/** The erasure ledger in the platform database (decision 498). */
export interface IErasureLedger {
  create(
    entry: Readonly<{
      tenantId: string;
      subjectType: ErasureSubject;
      subjectId: string;
      requestId: string | null;
      reason: string;
      approvalId: string | null;
      requestedBy: string;
      approvedBy: string | null;
    }>,
  ): Promise<string>;
  find(id: string): Promise<ErasureEntry | null>;
  findSubject(
    tenantId: string,
    type: ErasureSubject,
    subjectId: string,
  ): Promise<ErasureEntry | null>;
  /** Every entry of a tenant, oldest first. */
  forTenant(tenantId: string): Promise<ErasureEntry[]>;
  list(
    filter: Readonly<{ tenantId?: string; requestId?: string; limit: number }>,
  ): Promise<ErasureEntry[]>;
  applied(id: string, report: ErasureReport, at: Date): Promise<void>;
  failed(id: string, error: string): Promise<void>;
  reapplied(id: string, at: Date): Promise<void>;
}
