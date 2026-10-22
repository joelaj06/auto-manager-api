import {
  DEFAULT_WORKPAY_SETTINGS,
  type AgreementListFilter,
  type AllocationRecord,
  type DowntimeRecord,
  type DvlaStatus,
  type HandedOverItem,
  type IWorkPayTransfers,
  type TransferRecord,
  type IWorkPayLifecycleRecords,
  type RescheduleRecord,
  type SettlementQuoteRecord,
  type InstalmentRecord,
  type IWorkPayAgreementRepository,
  type IWorkPaySchedule,
  type IWorkPaySettingsStore,
  type WorkPaySettings,
} from "../../application/ports/IWorkPayRecords.js";
import {
  WorkPayAgreement,
  type Closure,
  type Guarantor,
  type WorkPayAgreementProps,
} from "../../domain/workpay/WorkPayAgreement.js";
import type {
  ChargeState,
  InstalmentState,
  PenaltyRule,
  PenaltyState,
} from "../../domain/workpay/WorkPayCollections.js";
import type { Instalment } from "../../domain/workpay/WorkPayTerms.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

type Row = {
  id: string;
  number: string;
  vehicle_id: string;
  driver_id: string;
  branch_id: string;
  status: WorkPayAgreementProps["status"];
  vehicle_value_minor: string;
  pricing_kind: WorkPayAgreementProps["terms"]["pricingKind"];
  pricing_value: string;
  total_price_minor: string;
  markup_minor: string;
  deposit_minor: string;
  financed_minor: string;
  frequency: WorkPayAgreementProps["terms"]["frequency"];
  periods: number;
  instalment_minor: string;
  last_instalment_minor: string;
  first_due_on: string;
  last_due_on: string;
  days_off: number[];
  round_to_minor: number;
  grace_days: number;
  maintenance: WorkPayAgreementProps["maintenance"];
  insurance: WorkPayAgreementProps["insurance"];
  deposit_paid_minor: string;
  penalty_kind: "none" | "flat" | "percent" | "daily";
  penalty_value: string | null;
  penalty_cap_minor: string | null;
  arrears_since: string | null;
  completed_at: Date | null;
  rescheduled_frequency: WorkPayAgreementProps["terms"]["frequency"] | null;
  rescheduled_days_off: number[] | null;
  close_reason: Closure["reason"] | null;
  closed_on: string | null;
  close_notes: string | null;
  outstanding_at_close_minor: string | null;
  settlement_owed_minor: string;
  settlement_refund_minor: string;
  closed_by: string | null;
  notes: string | null;
  document_id: string | null;
  assignment_id: string | null;
  started_on: string | null;
  activated_by: string | null;
  activated_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  guarantors: Guarantor[] | null;
};

const SELECT = `select a.*, a.first_due_on::text as first_due_on, a.last_due_on::text as last_due_on,
       a.started_on::text as started_on, a.arrears_since::text as arrears_since,
       a.closed_on::text as closed_on,
       (select coalesce(json_agg(json_build_object('name', g.name, 'phone', g.phone,
          'ghanaCardNumber', g.ghana_card_number, 'relationship', g.relationship,
          'address', g.address, 'signs', g.signs) order by g.position), '[]'::json)
          from workpay_guarantors g where g.agreement_id = a.id) as guarantors
  from workpay_agreements a`;

const n = (v: string) => Number(v);

const toAgreement = (r: Row) =>
  WorkPayAgreement.restore({
    id: r.id,
    number: r.number,
    vehicleId: r.vehicle_id,
    driverId: r.driver_id,
    branchId: r.branch_id,
    status: r.status,
    terms: {
      vehicleValueMinor: n(r.vehicle_value_minor),
      pricingKind: r.pricing_kind,
      pricingValue: r.pricing_value,
      totalPriceMinor: n(r.total_price_minor),
      markupMinor: n(r.markup_minor),
      depositMinor: n(r.deposit_minor),
      financedMinor: n(r.financed_minor),
      frequency: r.frequency,
      periods: r.periods,
      instalmentMinor: n(r.instalment_minor),
      lastInstalmentMinor: n(r.last_instalment_minor),
      firstDueOn: r.first_due_on,
      lastDueOn: r.last_due_on,
      daysOff: r.days_off,
      roundToMinor: r.round_to_minor,
    },
    graceDays: r.grace_days,
    penalty: penaltyOf(r),
    arrearsSince: r.arrears_since,
    completedAt: r.completed_at,
    rescheduledBasis:
      r.rescheduled_frequency === null
        ? null
        : { frequency: r.rescheduled_frequency, daysOff: r.rescheduled_days_off ?? [] },
    closure:
      r.closed_on === null
        ? null
        : {
            reason: r.close_reason!,
            on: r.closed_on,
            notes: r.close_notes,
            outstandingMinor: n(r.outstanding_at_close_minor ?? "0"),
            owedMinor: n(r.settlement_owed_minor),
            refundMinor: n(r.settlement_refund_minor),
            by: r.closed_by!,
          },
    maintenance: r.maintenance,
    insurance: r.insurance,
    depositPaidMinor: n(r.deposit_paid_minor),
    guarantors: r.guarantors ?? [],
    notes: r.notes,
    documentId: r.document_id,
    assignmentId: r.assignment_id,
    startedOn: r.started_on,
    activatedBy: r.activated_by,
    activatedAt: r.activated_at,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

function penaltyOf(r: Row): PenaltyRule {
  switch (r.penalty_kind) {
    case "none":
      return { kind: "none" };
    case "percent":
      return { kind: "percent", percent: r.penalty_value! };
    case "flat":
      return { kind: "flat", amountMinor: Number(r.penalty_value) };
    case "daily":
      return {
        kind: "daily",
        amountMinor: Number(r.penalty_value),
        capMinor: r.penalty_cap_minor === null ? null : Number(r.penalty_cap_minor),
      };
  }
}

const penaltyColumns = (rule: PenaltyRule) =>
  rule.kind === "none"
    ? [rule.kind, null, null]
    : rule.kind === "percent"
      ? [rule.kind, rule.percent, null]
      : [rule.kind, String(rule.amountMinor), rule.kind === "daily" ? rule.capMinor : null];

const LIVE = ["awaiting_signatures", "active", "in_arrears", "defaulted"];

export class PostgresWorkPayAgreements implements IWorkPayAgreementRepository {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  private async one(where: string, params: unknown[], lock = false) {
    const { rows } = await this.tx.query<Row>(
      `${SELECT} ${where}${lock ? " for update of a" : ""}`,
      params,
    );
    return rows[0] === undefined ? null : toAgreement(rows[0]);
  }

  findById(id: string) {
    return this.one("where a.id = $1", [id]);
  }

  lockById(id: string) {
    return this.one("where a.id = $1", [id], true);
  }

  byDocument(documentId: string) {
    return this.one("where a.document_id = $1", [documentId]);
  }

  liveFor(party: Readonly<{ vehicleId?: string; driverId?: string }>) {
    return this.one(
      `where a.status = any($3::text[])
         and (($1::uuid is not null and a.vehicle_id = $1) or ($2::uuid is not null and a.driver_id = $2))
       limit 1`,
      [party.vehicleId ?? null, party.driverId ?? null, LIVE],
    );
  }

  async save(agreement: WorkPayAgreement): Promise<void> {
    const p = agreement.snapshot();
    const t = p.terms;
    await this.tx.query(
      `insert into workpay_agreements (id, number, vehicle_id, driver_id, branch_id, status,
         vehicle_value_minor, pricing_kind, pricing_value, total_price_minor, markup_minor,
         deposit_minor, financed_minor, frequency, periods, instalment_minor, last_instalment_minor,
         first_due_on, last_due_on, days_off, round_to_minor, grace_days, maintenance, insurance,
         deposit_paid_minor, notes, document_id, assignment_id, started_on, activated_by,
         activated_at, cancelled_at, cancel_reason, created_by, created_at, updated_at,
         penalty_kind, penalty_value, penalty_cap_minor, arrears_since, completed_at,
         rescheduled_frequency, rescheduled_days_off, close_reason, closed_on, close_notes,
         outstanding_at_close_minor, settlement_owed_minor, settlement_refund_minor, closed_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
               $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34,
               $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, $48, $49, $50)
       on conflict (id) do update set status = excluded.status,
         vehicle_value_minor = excluded.vehicle_value_minor, pricing_kind = excluded.pricing_kind,
         pricing_value = excluded.pricing_value, total_price_minor = excluded.total_price_minor,
         markup_minor = excluded.markup_minor, deposit_minor = excluded.deposit_minor,
         financed_minor = excluded.financed_minor, frequency = excluded.frequency,
         periods = excluded.periods, instalment_minor = excluded.instalment_minor,
         last_instalment_minor = excluded.last_instalment_minor,
         first_due_on = excluded.first_due_on, last_due_on = excluded.last_due_on,
         days_off = excluded.days_off, round_to_minor = excluded.round_to_minor,
         grace_days = excluded.grace_days, maintenance = excluded.maintenance,
         insurance = excluded.insurance, deposit_paid_minor = excluded.deposit_paid_minor,
         notes = excluded.notes, document_id = excluded.document_id,
         assignment_id = excluded.assignment_id, started_on = excluded.started_on,
         activated_by = excluded.activated_by, activated_at = excluded.activated_at,
         cancelled_at = excluded.cancelled_at, cancel_reason = excluded.cancel_reason,
         updated_at = excluded.updated_at, penalty_kind = excluded.penalty_kind,
         penalty_value = excluded.penalty_value, penalty_cap_minor = excluded.penalty_cap_minor,
         arrears_since = excluded.arrears_since, completed_at = excluded.completed_at,
         rescheduled_frequency = excluded.rescheduled_frequency,
         rescheduled_days_off = excluded.rescheduled_days_off,
         close_reason = excluded.close_reason, closed_on = excluded.closed_on,
         close_notes = excluded.close_notes,
         outstanding_at_close_minor = excluded.outstanding_at_close_minor,
         settlement_owed_minor = excluded.settlement_owed_minor,
         settlement_refund_minor = excluded.settlement_refund_minor,
         closed_by = excluded.closed_by`,
      [
        p.id,
        p.number,
        p.vehicleId,
        p.driverId,
        p.branchId,
        p.status,
        t.vehicleValueMinor,
        t.pricingKind,
        t.pricingValue,
        t.totalPriceMinor,
        t.markupMinor,
        t.depositMinor,
        t.financedMinor,
        t.frequency,
        t.periods,
        t.instalmentMinor,
        t.lastInstalmentMinor,
        t.firstDueOn,
        t.lastDueOn,
        t.daysOff,
        t.roundToMinor,
        p.graceDays,
        p.maintenance,
        p.insurance,
        p.depositPaidMinor,
        p.notes,
        p.documentId,
        p.assignmentId,
        p.startedOn,
        p.activatedBy,
        p.activatedAt,
        p.cancelledAt,
        p.cancelReason,
        p.createdBy,
        p.createdAt,
        p.updatedAt,
        ...penaltyColumns(p.penalty),
        p.arrearsSince,
        p.completedAt,
        p.rescheduledBasis?.frequency ?? null,
        p.rescheduledBasis?.daysOff ?? null,
        p.closure?.reason ?? null,
        p.closure?.on ?? null,
        p.closure?.notes ?? null,
        p.closure?.outstandingMinor ?? null,
        p.closure?.owedMinor ?? 0,
        p.closure?.refundMinor ?? 0,
        p.closure?.by ?? null,
      ],
    );
    await this.tx.query("delete from workpay_guarantors where agreement_id = $1", [p.id]);
    for (const [i, g] of p.guarantors.entries())
      await this.tx.query(
        `insert into workpay_guarantors (agreement_id, position, name, phone, ghana_card_number,
           relationship, address, signs)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [p.id, i + 1, g.name, g.phone, g.ghanaCardNumber, g.relationship, g.address, g.signs],
      );
  }

  async running(): Promise<string[]> {
    const { rows } = await this.tx.query<{ id: string }>(
      "select id from workpay_agreements where status in ('active', 'in_arrears', 'defaulted') order by id",
    );
    return rows.map((r) => r.id);
  }

  async list(filter: AgreementListFilter): Promise<WorkPayAgreement[]> {
    const { rows } = await this.tx.query<Row>(
      `${SELECT}
        where ($1::uuid[] is null or a.branch_id = any($1::uuid[]))
          and ($2::uuid is null or a.branch_id = $2)
          and ($3::text[] is null or a.status = any($3::text[]))
          and ($4::uuid is null or a.driver_id = $4)
          and ($5::uuid is null or a.vehicle_id = $5)
          and ($6::uuid is null or a.id < $6)
        order by a.id desc
        limit $7`,
      [
        filter.branchIds === "all" ? null : filter.branchIds,
        filter.branchId ?? null,
        filter.statuses ?? null,
        filter.driverId ?? null,
        filter.vehicleId ?? null,
        filter.afterId ?? null,
        filter.limit,
      ],
    );
    return rows.map(toAgreement);
  }
}

type InstalmentRow = {
  id: string;
  agreement_id: string;
  number: number;
  due_on: string;
  amount_minor: string;
  paid_minor: string;
  waived_minor: string;
  rescheduled_minor: string;
  status: InstalmentRecord["status"];
};
type PenaltyRow = {
  id: string;
  instalment_id: string;
  charged_on: string;
  amount_minor: string;
  paid_minor: string;
  waived_minor: string;
};
type AllocationRow = {
  id: string;
  agreement_id: string;
  payment_id: string;
  instalment_id: string | null;
  penalty_id: string | null;
  charge_id: string | null;
  amount_minor: string;
  released_at: Date | null;
  created_at: Date;
};

type ChargeRow = {
  id: string;
  agreement_id: string;
  description: string;
  charged_on: string;
  amount_minor: string;
  paid_minor: string;
  waived_minor: string;
};

const toCharge = (r: ChargeRow): ChargeState => ({
  id: r.id,
  chargedOn: r.charged_on,
  description: r.description,
  amountMinor: Number(r.amount_minor),
  paidMinor: Number(r.paid_minor),
  waivedMinor: Number(r.waived_minor),
});

const toAllocation = (r: AllocationRow): AllocationRecord => ({
  id: r.id,
  agreementId: r.agreement_id,
  paymentId: r.payment_id,
  instalmentId: r.instalment_id,
  penaltyId: r.penalty_id,
  chargeId: r.charge_id,
  amountMinor: Number(r.amount_minor),
  releasedAt: r.released_at,
  createdAt: r.created_at,
});

export class PostgresWorkPaySchedule implements IWorkPaySchedule {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async create(agreementId: string, instalments: readonly Instalment[]): Promise<void> {
    if (instalments.length === 0) return;
    await this.tx.query(
      `insert into workpay_instalments (agreement_id, number, due_on, amount_minor)
       select $1, n, d, a from unnest($2::int[], $3::date[], $4::bigint[]) as t(n, d, a)`,
      [
        agreementId,
        instalments.map((i) => i.number),
        instalments.map((i) => i.dueOn),
        instalments.map((i) => i.amountMinor),
      ],
    );
  }

  async list(agreementId: string, lock = false): Promise<InstalmentRecord[]> {
    const { rows } = await this.tx.query<InstalmentRow>(
      `select id, agreement_id, number, due_on::text as due_on, amount_minor, paid_minor,
              waived_minor, rescheduled_minor, status
         from workpay_instalments where agreement_id = $1 order by number${lock ? " for update" : ""}`,
      [agreementId],
    );
    return rows.map((r) => ({
      id: r.id,
      agreementId: r.agreement_id,
      number: r.number,
      dueOn: r.due_on,
      amountMinor: Number(r.amount_minor),
      paidMinor: Number(r.paid_minor),
      waivedMinor: Number(r.waived_minor),
      rescheduledMinor: Number(r.rescheduled_minor),
      status: r.status,
    }));
  }

  async saveInstalment(i: InstalmentState): Promise<void> {
    await this.tx.query(
      `update workpay_instalments set paid_minor = $2, waived_minor = $3, rescheduled_minor = $4,
         status = $5 where id = $1`,
      [i.id, i.paidMinor, i.waivedMinor, i.rescheduledMinor, i.status],
    );
  }

  async penalties(agreementId: string, lock = false): Promise<PenaltyState[]> {
    const { rows } = await this.tx.query<PenaltyRow>(
      `select id, instalment_id, charged_on::text as charged_on, amount_minor, paid_minor,
              waived_minor
         from workpay_penalties where agreement_id = $1 order by charged_on, id${lock ? " for update" : ""}`,
      [agreementId],
    );
    return rows.map((r) => ({
      id: r.id,
      instalmentId: r.instalment_id,
      chargedOn: r.charged_on,
      amountMinor: Number(r.amount_minor),
      paidMinor: Number(r.paid_minor),
      waivedMinor: Number(r.waived_minor),
    }));
  }

  async addPenalty(p: Parameters<IWorkPaySchedule["addPenalty"]>[0]): Promise<string | null> {
    const { rows } = await this.tx.query<{ id: string }>(
      `insert into workpay_penalties (agreement_id, instalment_id, charged_on, amount_minor)
       values ($1, $2, $3, $4)
       on conflict (instalment_id, charged_on) do nothing
       returning id`,
      [p.agreementId, p.instalmentId, p.chargedOn, p.amountMinor],
    );
    return rows[0]?.id ?? null;
  }

  async savePenalty(p: PenaltyState): Promise<void> {
    await this.tx.query(
      "update workpay_penalties set paid_minor = $2, waived_minor = $3 where id = $1",
      [p.id, p.paidMinor, p.waivedMinor],
    );
  }

  async addAllocation(a: Parameters<IWorkPaySchedule["addAllocation"]>[0]): Promise<void> {
    await this.tx.query(
      `insert into workpay_allocations (agreement_id, payment_id, instalment_id, penalty_id,
         charge_id, amount_minor)
       values ($1, $2, $3, $4, $5, $6)`,
      [a.agreementId, a.paymentId, a.instalmentId, a.penaltyId, a.chargeId, a.amountMinor],
    );
  }

  async openAllocations(paymentId: string): Promise<AllocationRecord[]> {
    const { rows } = await this.tx.query<AllocationRow>(
      `select * from workpay_allocations where payment_id = $1 and released_at is null
        order by id for update`,
      [paymentId],
    );
    return rows.map(toAllocation);
  }

  async releaseAllocation(id: string, now: Date): Promise<void> {
    await this.tx.query("update workpay_allocations set released_at = $2 where id = $1", [id, now]);
  }

  async allocations(agreementId: string): Promise<AllocationRecord[]> {
    const { rows } = await this.tx.query<AllocationRow>(
      "select * from workpay_allocations where agreement_id = $1 order by id desc",
      [agreementId],
    );
    return rows.map(toAllocation);
  }

  async addWaiver(w: Parameters<IWorkPaySchedule["addWaiver"]>[0]): Promise<string> {
    const { rows } = await this.tx.query<{ id: string }>(
      `insert into workpay_waivers (agreement_id, instalment_id, penalty_id, amount_minor, reason,
         waived_by, quote_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id`,
      [
        w.agreementId,
        w.instalmentId,
        w.penaltyId,
        w.amountMinor,
        w.reason,
        w.waivedBy,
        w.quoteId ?? null,
      ],
    );
    return rows[0]!.id;
  }

  async reverseQuoteWaivers(quoteId: string, now: Date) {
    const { rows } = await this.tx.query<{ instalment_id: string; amount_minor: string }>(
      `update workpay_waivers set reversed_at = $2
        where quote_id = $1 and reversed_at is null
        returning instalment_id, amount_minor`,
      [quoteId, now],
    );
    return rows.map((r) => ({
      instalmentId: r.instalment_id,
      amountMinor: Number(r.amount_minor),
    }));
  }

  async charges(agreementId: string, lock = false): Promise<ChargeState[]> {
    const { rows } = await this.tx.query<ChargeRow>(
      `select id, agreement_id, description, charged_on::text as charged_on, amount_minor,
              paid_minor, waived_minor
         from workpay_charges where agreement_id = $1
        order by charged_on, id${lock ? " for update" : ""}`,
      [agreementId],
    );
    return rows.map(toCharge);
  }

  async addCharge(c: Parameters<IWorkPaySchedule["addCharge"]>[0]): Promise<string> {
    const { rows } = await this.tx.query<{ id: string }>(
      `insert into workpay_charges (agreement_id, expense_id, description, charged_on, amount_minor)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [c.agreementId, c.expenseId, c.description, c.chargedOn, c.amountMinor],
    );
    return rows[0]!.id;
  }

  async chargeForExpense(expenseId: string) {
    const { rows } = await this.tx.query<ChargeRow>(
      `select id, agreement_id, description, charged_on::text as charged_on, amount_minor,
              paid_minor, waived_minor
         from workpay_charges where expense_id = $1 for update`,
      [expenseId],
    );
    return rows[0] === undefined
      ? null
      : { ...toCharge(rows[0]), agreementId: rows[0].agreement_id };
  }

  async saveCharge(c: ChargeState): Promise<void> {
    await this.tx.query(
      "update workpay_charges set paid_minor = $2, waived_minor = $3 where id = $1",
      [c.id, c.paidMinor, c.waivedMinor],
    );
  }
}

type QuoteRow = {
  id: string;
  agreement_id: string;
  quoted_on: string;
  valid_until: string;
  instalments_minor: string;
  penalties_minor: string;
  charges_minor: string;
  discount_percent: string;
  discount_minor: string;
  payoff_minor: string;
  payment_id: string | null;
  used_at: Date | null;
  created_by: string | null;
  created_at: Date;
};

const QUOTE = `select *, quoted_on::text as quoted_on, valid_until::text as valid_until
                 from workpay_settlement_quotes`;

const toQuote = (r: QuoteRow): SettlementQuoteRecord => ({
  id: r.id,
  agreementId: r.agreement_id,
  quotedOn: r.quoted_on,
  validUntil: r.valid_until,
  instalmentsMinor: Number(r.instalments_minor),
  penaltiesMinor: Number(r.penalties_minor),
  chargesMinor: Number(r.charges_minor),
  discountPercent: r.discount_percent,
  discountMinor: Number(r.discount_minor),
  payoffMinor: Number(r.payoff_minor),
  paymentId: r.payment_id,
  usedAt: r.used_at,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

type DowntimeRow = {
  id: string;
  agreement_id: string;
  reason: string;
  owner_fault: boolean;
  started_on: string;
  ended_on: string | null;
  started_by: string | null;
  ended_by: string | null;
};

const DOWNTIME = `select id, agreement_id, reason, owner_fault, started_on::text as started_on,
                         ended_on::text as ended_on, started_by, ended_by
                    from workpay_downtimes`;

const toDowntime = (r: DowntimeRow): DowntimeRecord => ({
  id: r.id,
  agreementId: r.agreement_id,
  reason: r.reason,
  ownerFault: r.owner_fault,
  startedOn: r.started_on,
  endedOn: r.ended_on,
  startedBy: r.started_by,
  endedBy: r.ended_by,
});

export class PostgresWorkPayLifecycle implements IWorkPayLifecycleRecords {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async addReschedule(r: Omit<RescheduleRecord, "id" | "createdAt">): Promise<string> {
    const { rows } = await this.tx.query<{ id: string }>(
      `insert into workpay_reschedules (agreement_id, kind, reason, params, moved_minor,
         moved_numbers, created_numbers, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id`,
      [
        r.agreementId,
        r.kind,
        r.reason,
        JSON.stringify(r.params),
        r.movedMinor,
        r.movedNumbers,
        r.createdNumbers,
        r.createdBy,
      ],
    );
    return rows[0]!.id;
  }

  async reschedules(agreementId: string): Promise<RescheduleRecord[]> {
    const { rows } = await this.tx.query<{
      id: string;
      agreement_id: string;
      kind: RescheduleRecord["kind"];
      reason: string;
      params: Record<string, unknown>;
      moved_minor: string;
      moved_numbers: number[];
      created_numbers: number[];
      created_by: string | null;
      created_at: Date;
    }>("select * from workpay_reschedules where agreement_id = $1 order by id desc", [agreementId]);
    return rows.map((r) => ({
      id: r.id,
      agreementId: r.agreement_id,
      kind: r.kind,
      reason: r.reason,
      params: r.params,
      movedMinor: Number(r.moved_minor),
      movedNumbers: r.moved_numbers,
      createdNumbers: r.created_numbers,
      createdBy: r.created_by,
      createdAt: r.created_at,
    }));
  }

  async addQuote(
    q: Omit<SettlementQuoteRecord, "id" | "paymentId" | "usedAt" | "createdAt">,
  ): Promise<string> {
    const { rows } = await this.tx.query<{ id: string }>(
      `insert into workpay_settlement_quotes (agreement_id, quoted_on, valid_until,
         instalments_minor, penalties_minor, charges_minor, discount_percent, discount_minor,
         payoff_minor, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning id`,
      [
        q.agreementId,
        q.quotedOn,
        q.validUntil,
        q.instalmentsMinor,
        q.penaltiesMinor,
        q.chargesMinor,
        q.discountPercent,
        q.discountMinor,
        q.payoffMinor,
        q.createdBy,
      ],
    );
    return rows[0]!.id;
  }

  async quote(id: string, lock = false): Promise<SettlementQuoteRecord | null> {
    const { rows } = await this.tx.query<QuoteRow>(
      `${QUOTE} where id = $1${lock ? " for update" : ""}`,
      [id],
    );
    return rows[0] === undefined ? null : toQuote(rows[0]);
  }

  async quoteForPayment(paymentId: string): Promise<SettlementQuoteRecord | null> {
    const { rows } = await this.tx.query<QuoteRow>(`${QUOTE} where payment_id = $1`, [paymentId]);
    return rows[0] === undefined ? null : toQuote(rows[0]);
  }

  async markQuoteUsed(id: string, paymentId: string | null, now: Date | null): Promise<void> {
    await this.tx.query(
      "update workpay_settlement_quotes set payment_id = $2, used_at = $3 where id = $1",
      [id, paymentId, now],
    );
  }

  async openDowntime(agreementId: string): Promise<DowntimeRecord | null> {
    const { rows } = await this.tx.query<DowntimeRow>(
      `${DOWNTIME} where agreement_id = $1 and ended_on is null for update`,
      [agreementId],
    );
    return rows[0] === undefined ? null : toDowntime(rows[0]);
  }

  async addDowntime(d: Omit<DowntimeRecord, "id" | "endedOn" | "endedBy">): Promise<string> {
    const { rows } = await this.tx.query<{ id: string }>(
      `insert into workpay_downtimes (agreement_id, reason, owner_fault, started_on, started_by)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [d.agreementId, d.reason, d.ownerFault, d.startedOn, d.startedBy],
    );
    return rows[0]!.id;
  }

  async endDowntime(id: string, endedOn: string, endedBy: string): Promise<void> {
    await this.tx.query("update workpay_downtimes set ended_on = $2, ended_by = $3 where id = $1", [
      id,
      endedOn,
      endedBy,
    ]);
  }

  async downtimes(agreementId: string): Promise<DowntimeRecord[]> {
    const { rows } = await this.tx.query<DowntimeRow>(
      `${DOWNTIME} where agreement_id = $1 order by started_on desc, id desc`,
      [agreementId],
    );
    return rows.map(toDowntime);
  }
}

type TransferRow = {
  id: string;
  agreement_id: string;
  document_id: string;
  odometer: number;
  condition: string | null;
  handed_over: HandedOverItem[];
  owner_signer_id: string;
  issued_by: string | null;
  issued_at: Date;
  transferred_at: Date | null;
  dvla_status: DvlaStatus;
  dvla_submitted_on: string | null;
  dvla_completed_on: string | null;
  dvla_reference: string | null;
  dvla_notes: string | null;
};

const TRANSFER = `select *, dvla_submitted_on::text as dvla_submitted_on,
                         dvla_completed_on::text as dvla_completed_on
                    from workpay_transfers`;

const toTransfer = (r: TransferRow): TransferRecord => ({
  id: r.id,
  agreementId: r.agreement_id,
  documentId: r.document_id,
  odometer: r.odometer,
  condition: r.condition,
  handedOver: r.handed_over,
  ownerSignerId: r.owner_signer_id,
  issuedBy: r.issued_by,
  issuedAt: r.issued_at,
  transferredAt: r.transferred_at,
  dvla: {
    status: r.dvla_status,
    submittedOn: r.dvla_submitted_on,
    completedOn: r.dvla_completed_on,
    reference: r.dvla_reference,
    notes: r.dvla_notes,
  },
});

export class PostgresWorkPayTransfers implements IWorkPayTransfers {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  private async one(where: string, id: string, lock: boolean) {
    const { rows } = await this.tx.query<TransferRow>(
      `${TRANSFER} where ${where} = $1${lock ? " for update" : ""}`,
      [id],
    );
    return rows[0] === undefined ? null : toTransfer(rows[0]);
  }

  forAgreement(agreementId: string, lock = false) {
    return this.one("agreement_id", agreementId, lock);
  }

  forDocument(documentId: string, lock = false) {
    return this.one("document_id", documentId, lock);
  }

  async save(t: TransferRecord): Promise<void> {
    await this.tx.query(
      `insert into workpay_transfers (id, agreement_id, document_id, odometer, condition,
         handed_over, owner_signer_id, issued_by, issued_at, transferred_at, dvla_status,
         dvla_submitted_on, dvla_completed_on, dvla_reference, dvla_notes, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
       on conflict (agreement_id) do update set
         document_id = excluded.document_id, odometer = excluded.odometer,
         condition = excluded.condition, handed_over = excluded.handed_over,
         owner_signer_id = excluded.owner_signer_id, issued_by = excluded.issued_by,
         issued_at = excluded.issued_at, transferred_at = excluded.transferred_at,
         dvla_status = excluded.dvla_status, dvla_submitted_on = excluded.dvla_submitted_on,
         dvla_completed_on = excluded.dvla_completed_on, dvla_reference = excluded.dvla_reference,
         dvla_notes = excluded.dvla_notes, updated_at = now()`,
      [
        t.id,
        t.agreementId,
        t.documentId,
        t.odometer,
        t.condition,
        JSON.stringify(t.handedOver),
        t.ownerSignerId,
        t.issuedBy,
        t.issuedAt,
        t.transferredAt,
        t.dvla.status,
        t.dvla.submittedOn,
        t.dvla.completedOn,
        t.dvla.reference,
        t.dvla.notes,
      ],
    );
  }

  async remove(agreementId: string): Promise<void> {
    await this.tx.query("delete from workpay_transfers where agreement_id = $1", [agreementId]);
  }
}

/** Work & Pay settings in `organisation.settings->'workpay'`, over the defaults. */
export class PostgresWorkPaySettingsStore implements IWorkPaySettingsStore {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async get(): Promise<WorkPaySettings> {
    const { rows } = await this.transactions
      .current()
      .query<{ workpay: Partial<WorkPaySettings> | null }>(
        "select settings->'workpay' as workpay from organisation",
      );
    return { ...DEFAULT_WORKPAY_SETTINGS, ...(rows[0]?.workpay ?? {}) };
  }

  async set(settings: WorkPaySettings): Promise<void> {
    await this.transactions
      .current()
      .query(
        "update organisation set settings = jsonb_set(settings, '{workpay}', $1::jsonb), updated_at = now()",
        [JSON.stringify(settings)],
      );
  }
}
