export type ReconciliationOutcome = "matched" | "fixed" | "over_limit" | "failed";

export type BranchReconciliation = Readonly<{
  id: string;
  tenantId: string;
  activeBranches: number | null;
  billedBefore: number | null;
  billedAfter: number | null;
  branchesMax: number | null;
  subscriptionStatus: string | null;
  outcome: ReconciliationOutcome;
  source: "job" | "staff";
  error: string | null;
  createdAt: Date;
}>;

/** A tenant with more active branches than it pays for. */
export type OverLimitTenant = Readonly<{
  tenantId: string;
  tenantName: string;
  billedBranches: number;
  activeBranches: number | null;
  overLimitSince: Date;
}>;

/** Billed branches against the tenants' active branches (platform database). */
export interface IBranchReconciliationRepository {
  record(entry: Omit<BranchReconciliation, "id" | "createdAt">): Promise<BranchReconciliation>;
  list(
    filter: Readonly<{ tenantId?: string; outcome?: ReconciliationOutcome; limit: number }>,
  ): Promise<BranchReconciliation[]>;
  /** Marks the subscription over its limit (keeps the first date) or within it (null). */
  setOverLimit(tenantId: string, overLimit: boolean, now: Date): Promise<void>;
  overLimit(): Promise<OverLimitTenant[]>;
}
