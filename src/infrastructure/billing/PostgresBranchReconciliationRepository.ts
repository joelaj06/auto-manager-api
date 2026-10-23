import type {
  BranchReconciliation,
  IBranchReconciliationRepository,
  OverLimitTenant,
  ReconciliationOutcome,
} from "../../domain/repositories/IBranchReconciliationRepository.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

type Row = {
  id: string;
  tenant_id: string;
  active_branches: number | null;
  billed_before: number | null;
  billed_after: number | null;
  branches_max: number | null;
  subscription_status: string | null;
  outcome: ReconciliationOutcome;
  source: "job" | "staff";
  error: string | null;
  created_at: Date;
};

const toEntry = (r: Row): BranchReconciliation => ({
  id: r.id,
  tenantId: r.tenant_id,
  activeBranches: r.active_branches,
  billedBefore: r.billed_before,
  billedAfter: r.billed_after,
  branchesMax: r.branches_max,
  subscriptionStatus: r.subscription_status,
  outcome: r.outcome,
  source: r.source,
  error: r.error,
  createdAt: r.created_at,
});

export class PostgresBranchReconciliationRepository implements IBranchReconciliationRepository {
  constructor(private readonly db: PlatformDb) {}

  async record(e: Omit<BranchReconciliation, "id" | "createdAt">): Promise<BranchReconciliation> {
    const { rows } = await this.db.query<Row>(
      `insert into branch_reconciliations (tenant_id, active_branches, billed_before, billed_after,
         branches_max, subscription_status, outcome, source, error)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning *`,
      [
        e.tenantId,
        e.activeBranches,
        e.billedBefore,
        e.billedAfter,
        e.branchesMax,
        e.subscriptionStatus,
        e.outcome,
        e.source,
        e.error?.slice(0, 500) ?? null,
      ],
    );
    return toEntry(rows[0]!);
  }

  async list(
    filter: Readonly<{ tenantId?: string; outcome?: ReconciliationOutcome; limit: number }>,
  ): Promise<BranchReconciliation[]> {
    const { rows } = await this.db.query<Row>(
      `select * from branch_reconciliations
        where ($1::uuid is null or tenant_id = $1) and ($2::text is null or outcome = $2)
        order by created_at desc, id desc limit $3`,
      [filter.tenantId ?? null, filter.outcome ?? null, filter.limit],
    );
    return rows.map(toEntry);
  }

  async setOverLimit(tenantId: string, overLimit: boolean, now: Date): Promise<void> {
    await this.db.query(
      `update subscriptions
          set over_limit_since = case when $2 then coalesce(over_limit_since, $3) else null end
        where tenant_id = $1`,
      [tenantId, overLimit, now],
    );
  }

  async overLimit(): Promise<OverLimitTenant[]> {
    const { rows } = await this.db.query<{
      tenant_id: string;
      tenant_name: string;
      branch_count: number;
      active_branches: number | null;
      over_limit_since: Date;
    }>(
      `select s.tenant_id, t.name as tenant_name, s.branch_count, s.over_limit_since,
              (select r.active_branches from branch_reconciliations r
                where r.tenant_id = s.tenant_id order by r.created_at desc limit 1) as active_branches
         from subscriptions s join tenants t on t.id = s.tenant_id
        where s.over_limit_since is not null
        order by s.over_limit_since`,
    );
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      billedBranches: r.branch_count,
      activeBranches: r.active_branches,
      overLimitSince: r.over_limit_since,
    }));
  }
}
