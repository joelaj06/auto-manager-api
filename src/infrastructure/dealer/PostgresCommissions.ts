import type {
  CommissionFilter,
  CommissionLine,
  ICommissions,
  PayoutRecord,
} from "../../application/ports/IDealerCommissions.js";
import {
  Commission,
  CommissionPlan,
  type CommissionBasis,
  type CommissionProps,
  type CommissionTier,
} from "../../domain/dealer/Commission.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const COLUMNS = [
  "id",
  "deal_id",
  "user_id",
  "branch_id",
  "period",
  "kind",
  "plan_id",
  "basis",
  "rate",
  "base_minor",
  "share_percent",
  "amount_minor",
  "status",
  "accrued_on",
  "payable_on",
  "payout_id",
  "claws_back_id",
  "clawed_back_at",
  "clawback_reason",
  "created_at",
  "updated_at",
] as const;
type Column = (typeof COLUMNS)[number];
type Row = Record<Column, unknown>;
const SELECT = COLUMNS.map((c) =>
  c === "accrued_on" || c === "payable_on" ? `c.${c}::text as ${c}` : `c.${c}`,
).join(", ");

function toRow(p: CommissionProps): Row {
  return {
    id: p.id,
    deal_id: p.dealId,
    user_id: p.userId,
    branch_id: p.branchId,
    period: p.period,
    kind: p.kind,
    plan_id: p.planId,
    basis: p.basis,
    rate: p.rate,
    base_minor: p.baseMinor,
    share_percent: p.sharePercent,
    amount_minor: p.amountMinor,
    status: p.status,
    accrued_on: p.accruedOn,
    payable_on: p.payableOn,
    payout_id: p.payoutId,
    claws_back_id: p.clawsBackId,
    clawed_back_at: p.clawedBackAt,
    clawback_reason: p.clawbackReason,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

const toCommission = (r: Row): Commission =>
  Commission.restore({
    id: r.id as string,
    dealId: r.deal_id as string,
    userId: r.user_id as string,
    branchId: r.branch_id as string,
    period: r.period as string,
    kind: r.kind as CommissionProps["kind"],
    planId: r.plan_id as string | null,
    basis: r.basis as CommissionProps["basis"],
    rate: r.rate as string,
    baseMinor: Number(r.base_minor),
    sharePercent: Number(r.share_percent),
    amountMinor: Number(r.amount_minor),
    status: r.status as CommissionProps["status"],
    accruedOn: r.accrued_on as string,
    payableOn: r.payable_on as string | null,
    payoutId: r.payout_id as string | null,
    clawsBackId: r.claws_back_id as string | null,
    clawedBackAt: r.clawed_back_at as Date | null,
    clawbackReason: r.clawback_reason as string | null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  });

type PlanRow = {
  id: string;
  name: string;
  user_id: string | null;
  basis: CommissionBasis;
  tiers: CommissionTier[];
  active: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

const toPlan = (r: PlanRow): CommissionPlan =>
  CommissionPlan.restore({
    id: r.id,
    name: r.name,
    userId: r.user_id,
    basis: r.basis,
    tiers: r.tiers,
    active: r.active,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

export class PostgresCommissions implements ICommissions {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async insertPlan(plan: CommissionPlan): Promise<void> {
    const p = plan.snapshot();
    await this.tx.query(
      `insert into dealer_commission_plans (id, name, user_id, basis, tiers, active, created_by,
         created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        p.id,
        p.name,
        p.userId,
        p.basis,
        JSON.stringify(p.tiers),
        p.active,
        p.createdBy,
        p.createdAt,
        p.updatedAt,
      ],
    );
  }

  async updatePlan(plan: CommissionPlan): Promise<void> {
    const p = plan.snapshot();
    await this.tx.query(
      `update dealer_commission_plans set name = $2, basis = $3, tiers = $4, active = $5,
         updated_at = $6
        where id = $1`,
      [p.id, p.name, p.basis, JSON.stringify(p.tiers), p.active, p.updatedAt],
    );
  }

  async plan(id: string): Promise<CommissionPlan | null> {
    const { rows } = await this.tx.query<PlanRow>(
      "select * from dealer_commission_plans where id = $1",
      [id],
    );
    return rows[0] === undefined ? null : toPlan(rows[0]);
  }

  async plans(activeOnly: boolean): Promise<CommissionPlan[]> {
    const { rows } = await this.tx.query<PlanRow>(
      `select * from dealer_commission_plans where active or not $1
        order by active desc, user_id nulls first, created_at`,
      [activeOnly],
    );
    return rows.map(toPlan);
  }

  async planFor(userId: string): Promise<CommissionPlan | null> {
    const { rows } = await this.tx.query<PlanRow>(
      `select * from dealer_commission_plans
        where active and (user_id = $1 or user_id is null)
        order by user_id nulls last limit 1`,
      [userId],
    );
    return rows[0] === undefined ? null : toPlan(rows[0]);
  }

  async insert(commission: Commission): Promise<void> {
    const values = toRow(commission.snapshot());
    await this.tx.query(
      `insert into dealer_commissions (${COLUMNS.join(", ")})
       values (${COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})`,
      COLUMNS.map((c) => values[c]),
    );
  }

  async update(commission: Commission): Promise<void> {
    const values = toRow(commission.snapshot());
    const changed = COLUMNS.filter((c) => c !== "id" && c !== "created_at");
    await this.tx.query(
      `update dealer_commissions set ${changed.map((c, i) => `${c} = $${i + 2}`).join(", ")}
        where id = $1`,
      [values.id, ...changed.map((c) => values[c])],
    );
  }

  async lock(id: string): Promise<Commission | null> {
    const { rows } = await this.tx.query<Row>(
      `select ${SELECT} from dealer_commissions c where c.id = $1 for update`,
      [id],
    );
    return rows[0] === undefined ? null : toCommission(rows[0]);
  }

  async list(filter: CommissionFilter): Promise<CommissionLine[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (filter.branchIds !== "all") add("c.branch_id = any(?::uuid[])", filter.branchIds);
    if (filter.userId !== undefined) add("c.user_id = ?", filter.userId);
    if (filter.period !== undefined) add("c.period = ?", filter.period);
    if (filter.statuses !== undefined) add("c.status = any(?::text[])", filter.statuses);
    if (filter.dealId !== undefined) add("c.deal_id = ?", filter.dealId);
    const { rows } = await this.tx.query<
      Row & {
        deal_number: string;
        vehicle: string;
        delivered_on: string | null;
        user_name: string;
      }
    >(
      `select ${SELECT}, d.number as deal_number, d.delivered_on::text as delivered_on,
              concat_ws(' ', v.make, v.model, v.plate_number) as vehicle, u.name as user_name
         from dealer_commissions c
         join dealer_deals d on d.id = c.deal_id
         join vehicles v on v.id = d.vehicle_id
         join users u on u.id = c.user_id
        ${where.length === 0 ? "" : `where ${where.join(" and ")}`}
        order by c.period, u.name, c.accrued_on, c.id`,
      params,
    );
    return rows.map((r) => ({
      commission: toCommission(r),
      dealNumber: r.deal_number,
      vehicle: r.vehicle,
      deliveredOn: r.delivered_on,
      userName: r.user_name,
    }));
  }

  async unitsIn(userId: string, period: string): Promise<number> {
    const { rows } = await this.tx.query<{ n: string }>(
      `select count(*) as n from dealer_commissions
        where user_id = $1 and period = $2 and kind = 'earned' and clawback_reason is null`,
      [userId, period],
    );
    return Number(rows[0]!.n);
  }

  async paidUp(): Promise<string[]> {
    const { rows } = await this.tx.query<{ id: string }>(
      `select c.id from dealer_commissions c
         join dealer_deals d on d.id = c.deal_id
        where c.status = 'accrued' and d.invoice_id is not null
          and not exists (select 1 from invoices i
                           where i.id in (d.invoice_id, d.charge_invoice_id)
                             and i.status <> 'void' and i.paid_minor < i.total_minor)
        order by c.id`,
    );
    return rows.map((r) => r.id);
  }

  async payable(userId: string, period: string): Promise<Commission[]> {
    const { rows } = await this.tx.query<Row>(
      `select ${SELECT} from dealer_commissions c
        where c.user_id = $1 and c.period <= $2 and c.status = 'payable'
        order by c.period, c.id for update`,
      [userId, period],
    );
    return rows.map(toCommission);
  }

  async insertPayout(p: PayoutRecord): Promise<void> {
    await this.tx.query(
      `insert into dealer_commission_payouts (id, number, user_id, branch_id, period,
         amount_minor, method, paid_on, reference, journal_id, paid_by, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        p.id,
        p.number,
        p.userId,
        p.branchId,
        p.period,
        p.amountMinor,
        p.method,
        p.paidOn,
        p.reference,
        p.journalId,
        p.paidBy,
        p.createdAt,
      ],
    );
  }

  async payouts(
    filter: Readonly<{ userId?: string; branchIds: "all" | readonly string[]; period?: string }>,
  ): Promise<PayoutRecord[]> {
    const { rows } = await this.tx.query<{
      id: string;
      number: string;
      user_id: string;
      branch_id: string;
      period: string;
      amount_minor: string;
      method: PayoutRecord["method"];
      paid_on: string;
      reference: string | null;
      journal_id: string;
      paid_by: string | null;
      created_at: Date;
    }>(
      `select id, number, user_id, branch_id, period, amount_minor, method, paid_on::text as paid_on,
              reference, journal_id, paid_by, created_at
         from dealer_commission_payouts
        where ($1::uuid is null or user_id = $1) and ($2::uuid[] is null or branch_id = any($2))
          and ($3::text is null or period = $3)
        order by paid_on, id`,
      [
        filter.userId ?? null,
        filter.branchIds === "all" ? null : filter.branchIds,
        filter.period ?? null,
      ],
    );
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      userId: r.user_id,
      branchId: r.branch_id,
      period: r.period,
      amountMinor: Number(r.amount_minor),
      method: r.method,
      paidOn: r.paid_on,
      reference: r.reference,
      journalId: r.journal_id,
      paidBy: r.paid_by,
      createdAt: r.created_at,
    }));
  }
}
