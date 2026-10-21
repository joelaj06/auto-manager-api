import {
  DEFAULT_WORKPAY_SETTINGS,
  type AgreementListFilter,
  type InstalmentRecord,
  type IWorkPayAgreementRepository,
  type IWorkPaySchedule,
  type IWorkPaySettingsStore,
  type WorkPaySettings,
} from "../../application/ports/IWorkPayRecords.js";
import {
  WorkPayAgreement,
  type Guarantor,
  type WorkPayAgreementProps,
} from "../../domain/workpay/WorkPayAgreement.js";
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
       a.started_on::text as started_on,
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
         activated_at, cancelled_at, cancel_reason, created_by, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
               $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34,
               $35, $36)
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
         updated_at = excluded.updated_at`,
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

export class PostgresWorkPaySchedule implements IWorkPaySchedule {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async create(agreementId: string, instalments: readonly Instalment[]): Promise<void> {
    if (instalments.length === 0) return;
    await this.transactions.current().query(
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

  async list(agreementId: string): Promise<InstalmentRecord[]> {
    const { rows } = await this.transactions.current().query<{
      id: string;
      agreement_id: string;
      number: number;
      due_on: string;
      amount_minor: string;
      paid_minor: string;
      waived_minor: string;
      status: InstalmentRecord["status"];
    }>(
      `select id, agreement_id, number, due_on::text as due_on, amount_minor, paid_minor,
              waived_minor, status
         from workpay_instalments where agreement_id = $1 order by number`,
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
      status: r.status,
    }));
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
