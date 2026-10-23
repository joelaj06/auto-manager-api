import type { CommissionTerms, CommissionTermsInput } from "../../domain/partners/Commissions.js";
import type {
  CommissionAttribution,
  CommissionEntry,
  EntryFilter,
  IPartnerCommissionRepository,
  PartnerBalance,
  PayoutRecord,
  PayoutStatus,
} from "../../domain/repositories/IPartnerCommissionRepository.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TermsRow = {
  id: string;
  partner_id: string;
  version: number;
  standard_percent: string | null;
  enterprise_percent: string | null;
  hold_days: number;
  min_payout_minor: string;
  cap_per_tenant_minor: string | null;
  reason: string;
  created_by: string;
  effective_from: Date;
};

type EntryRow = {
  id: string;
  partner_id: string;
  tenant_id: string | null;
  kind: CommissionEntry["kind"];
  invoice_id: string | null;
  source_payment_id: string | null;
  source_refund_id: string | null;
  commission_type: CommissionEntry["commissionType"];
  terms_id: string | null;
  base_minor: string | null;
  rate_percent: string | null;
  amount_minor: string;
  currency: string;
  status: CommissionEntry["status"];
  release_at: Date | null;
  reason: string | null;
  created_by: string | null;
  payout_id: string | null;
  created_at: Date;
};

type PayoutRow = {
  id: string;
  code: string;
  partner_id: string;
  total_minor: string;
  currency: string;
  method: PayoutRecord["method"];
  reference: string | null;
  details: Record<string, string>;
  proof_file_ids: string[];
  notes: string | null;
  status: PayoutStatus;
  paid_at: Date;
  recorded_by: string;
  recorded_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  acknowledged_by: string | null;
  acknowledged_at: Date | null;
  reversed_by: string | null;
  reversed_at: Date | null;
  reversal_reason: string | null;
};

const toTerms = (r: TermsRow): CommissionTerms => ({
  id: r.id,
  partnerId: r.partner_id,
  version: r.version,
  standardPercent: r.standard_percent,
  enterprisePercent: r.enterprise_percent,
  holdDays: r.hold_days,
  minPayoutMinor: Number(r.min_payout_minor),
  capPerTenantMinor: r.cap_per_tenant_minor === null ? null : Number(r.cap_per_tenant_minor),
  reason: r.reason,
  createdBy: r.created_by,
  effectiveFrom: r.effective_from,
});

const toEntry = (r: EntryRow): CommissionEntry => ({
  id: r.id,
  partnerId: r.partner_id,
  tenantId: r.tenant_id,
  kind: r.kind,
  invoiceId: r.invoice_id,
  sourcePaymentId: r.source_payment_id,
  sourceRefundId: r.source_refund_id,
  commissionType: r.commission_type,
  termsId: r.terms_id,
  baseMinor: r.base_minor === null ? null : Number(r.base_minor),
  ratePercent: r.rate_percent,
  amountMinor: Number(r.amount_minor),
  currency: r.currency,
  status: r.status,
  releaseAt: r.release_at,
  reason: r.reason,
  createdBy: r.created_by,
  payoutId: r.payout_id,
  createdAt: r.created_at,
});

const toPayout = (r: PayoutRow): PayoutRecord => ({
  id: r.id,
  code: r.code,
  partnerId: r.partner_id,
  totalMinor: Number(r.total_minor),
  currency: r.currency,
  method: r.method,
  reference: r.reference,
  details: r.details,
  proofFileIds: r.proof_file_ids,
  notes: r.notes,
  status: r.status,
  paidAt: r.paid_at,
  recordedBy: r.recorded_by,
  recordedAt: r.recorded_at,
  approvedBy: r.approved_by,
  approvedAt: r.approved_at,
  acknowledgedBy: r.acknowledged_by,
  acknowledgedAt: r.acknowledged_at,
  reversedBy: r.reversed_by,
  reversedAt: r.reversed_at,
  reversalReason: r.reversal_reason,
});

const TERMS_COLUMNS = `id, partner_id, version, standard_percent::text, enterprise_percent::text,
  hold_days, min_payout_minor, cap_per_tenant_minor, reason, created_by, effective_from`;
const ENTRY_COLUMNS = `id, partner_id, tenant_id, kind, invoice_id, source_payment_id,
  source_refund_id, commission_type, terms_id, base_minor, rate_percent::text, amount_minor,
  currency, status, release_at, reason, created_by, payout_id, created_at`;

export class PostgresPartnerCommissionRepository implements IPartnerCommissionRepository {
  constructor(private readonly db: PlatformDb) {}

  async latestTerms(partnerId: string): Promise<CommissionTerms | null> {
    const { rows } = await this.db.query<TermsRow>(
      `select ${TERMS_COLUMNS} from partner_commission_terms
        where partner_id = $1 order by version desc limit 1`,
      [partnerId],
    );
    return rows[0] === undefined ? null : toTerms(rows[0]);
  }

  async termsById(id: string): Promise<CommissionTerms | null> {
    const { rows } = await this.db.query<TermsRow>(
      `select ${TERMS_COLUMNS} from partner_commission_terms where id = $1`,
      [id],
    );
    return rows[0] === undefined ? null : toTerms(rows[0]);
  }

  async termsHistory(partnerId: string): Promise<CommissionTerms[]> {
    const { rows } = await this.db.query<TermsRow>(
      `select ${TERMS_COLUMNS} from partner_commission_terms
        where partner_id = $1 order by version desc`,
      [partnerId],
    );
    return rows.map(toTerms);
  }

  async addTerms(
    partnerId: string,
    t: CommissionTermsInput,
    reason: string,
    staffId: string,
  ): Promise<CommissionTerms> {
    const { rows } = await this.db.query<TermsRow>(
      `insert into partner_commission_terms (partner_id, version, standard_percent,
         enterprise_percent, hold_days, min_payout_minor, cap_per_tenant_minor, reason, created_by)
       select $1, coalesce(max(version), 0) + 1, $2, $3, $4, $5, $6, $7, $8
         from partner_commission_terms where partner_id = $1
       returning ${TERMS_COLUMNS}`,
      [
        partnerId,
        t.standardPercent,
        t.enterprisePercent,
        t.holdDays,
        t.minPayoutMinor,
        t.capPerTenantMinor,
        reason,
        staffId,
      ],
    );
    return toTerms(rows[0]!);
  }

  async rebindTenants(partnerId: string, termsId: string): Promise<number> {
    const { rowCount } = await this.db.query(
      "update partner_tenant_attributions set terms_id = $2 where partner_id = $1",
      [partnerId, termsId],
    );
    return rowCount ?? 0;
  }

  async attribution(tenantId: string, lock = false): Promise<CommissionAttribution | null> {
    if (!UUID.test(tenantId)) return null;
    const { rows } = await this.db.query<{
      tenant_id: string;
      partner_id: string;
      partner_status: string;
      terms_id: string | null;
      override_percent: string | null;
      override_reason: string | null;
      commission_invoice_id: string | null;
    }>(
      `select a.tenant_id, a.partner_id, p.status as partner_status, a.terms_id,
              a.override_percent::text, a.override_reason, a.commission_invoice_id
         from partner_tenant_attributions a join partners p on p.id = a.partner_id
        where a.tenant_id = $1${lock ? " for update of a" : ""}`,
      [tenantId],
    );
    const r = rows[0];
    return r === undefined
      ? null
      : {
          tenantId: r.tenant_id,
          partnerId: r.partner_id,
          partnerStatus: r.partner_status,
          termsId: r.terms_id,
          overridePercent: r.override_percent,
          overrideReason: r.override_reason,
          commissionInvoiceId: r.commission_invoice_id,
        };
  }

  async bindTerms(tenantId: string, termsId: string): Promise<void> {
    await this.db.query(
      "update partner_tenant_attributions set terms_id = $2 where tenant_id = $1",
      [tenantId, termsId],
    );
  }

  async setOverride(
    tenantId: string,
    percent: string | null,
    reason: string | null,
  ): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `update partner_tenant_attributions set override_percent = $2, override_reason = $3
        where tenant_id = $1`,
      [tenantId, percent, reason],
    );
    return rowCount === 1;
  }

  async setCommissionInvoice(tenantId: string, invoiceId: string | null): Promise<void> {
    await this.db.query(
      "update partner_tenant_attributions set commission_invoice_id = $2 where tenant_id = $1",
      [tenantId, invoiceId],
    );
  }

  async addEntry(e: Omit<CommissionEntry, "createdAt" | "payoutId">): Promise<void> {
    await this.db.query(
      `insert into partner_commission_entries (id, partner_id, tenant_id, kind, invoice_id,
         source_payment_id, source_refund_id, commission_type, terms_id, base_minor, rate_percent,
         amount_minor, currency, status, release_at, reason, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       on conflict do nothing`,
      [
        e.id,
        e.partnerId,
        e.tenantId,
        e.kind,
        e.invoiceId,
        e.sourcePaymentId,
        e.sourceRefundId,
        e.commissionType,
        e.termsId,
        e.baseMinor,
        e.ratePercent,
        e.amountMinor,
        e.currency,
        e.status,
        e.releaseAt,
        e.reason,
        e.createdBy,
      ],
    );
  }

  async forPayment(paymentId: string): Promise<CommissionEntry[]> {
    const { rows } = await this.db.query<EntryRow>(
      `select ${ENTRY_COLUMNS} from partner_commission_entries
        where source_payment_id = $1 order by created_at, id`,
      [paymentId],
    );
    return rows.map(toEntry);
  }

  async tenantTotal(tenantId: string): Promise<number> {
    const { rows } = await this.db.query<{ total: string }>(
      `select coalesce(sum(amount_minor), 0) as total from partner_commission_entries
        where tenant_id = $1 and kind in ('commission', 'clawback')`,
      [tenantId],
    );
    return Number(rows[0]!.total);
  }

  async entries(f: EntryFilter): Promise<CommissionEntry[]> {
    const { rows } = await this.db.query<EntryRow>(
      `select ${ENTRY_COLUMNS} from partner_commission_entries
        where ($1::uuid is null or partner_id = $1) and ($2::uuid is null or tenant_id = $2)
          and ($3::text is null or status = $3) and ($4::text is null or commission_type = $4)
          and ($5::timestamptz is null or created_at >= $5)
          and ($6::timestamptz is null or created_at < $6)
        order by created_at desc, id desc limit $7`,
      [
        f.partnerId ?? null,
        f.tenantId ?? null,
        f.status ?? null,
        f.type ?? null,
        f.from ?? null,
        f.to ?? null,
        f.limit,
      ],
    );
    return rows.map(toEntry);
  }

  async releaseDue(now: Date): Promise<number> {
    const { rowCount } = await this.db.query(
      `update partner_commission_entries set status = 'payable'
        where status = 'accrued' and release_at <= $1`,
      [now],
    );
    return rowCount ?? 0;
  }

  async openPayable(partnerId: string): Promise<CommissionEntry[]> {
    const { rows } = await this.db.query<EntryRow>(
      `select ${ENTRY_COLUMNS} from partner_commission_entries
        where partner_id = $1 and status = 'payable' and payout_id is null
        order by created_at, id for update`,
      [partnerId],
    );
    return rows.map(toEntry);
  }

  async balances(partnerId?: string): Promise<PartnerBalance[]> {
    const { rows } = await this.db.query<{
      partner_id: string;
      partner_name: string;
      currency: string;
      payable: string;
      accrued: string;
      awaiting: string;
      min_payout: string | null;
    }>(
      `select e.partner_id, p.name as partner_name, e.currency,
              coalesce(sum(e.amount_minor) filter (where e.status = 'payable' and e.payout_id is null), 0) as payable,
              coalesce(sum(e.amount_minor) filter (where e.status = 'accrued'), 0) as accrued,
              coalesce(sum(e.amount_minor) filter (where e.status = 'payable' and e.payout_id is not null), 0) as awaiting,
              (select t.min_payout_minor from partner_commission_terms t
                where t.partner_id = e.partner_id order by t.version desc limit 1) as min_payout
         from partner_commission_entries e join partners p on p.id = e.partner_id
        where ($1::uuid is null or e.partner_id = $1)
        group by e.partner_id, p.name, e.currency
       having sum(e.amount_minor) filter (where e.status <> 'paid') <> 0
        order by payable desc, p.name`,
      [partnerId ?? null],
    );
    return rows.map((r) => ({
      partnerId: r.partner_id,
      partnerName: r.partner_name,
      currency: r.currency,
      payableMinor: Number(r.payable),
      accruedMinor: Number(r.accrued),
      awaitingApprovalMinor: Number(r.awaiting),
      minPayoutMinor: Number(r.min_payout ?? 0),
    }));
  }

  async balanceAt(partnerId: string, at: Date): Promise<number> {
    const { rows } = await this.db.query<{ balance: string }>(
      `select (select coalesce(sum(amount_minor), 0) from partner_commission_entries
                where partner_id = $1 and created_at < $2)
            - (select coalesce(sum(total_minor), 0) from partner_payouts
                where partner_id = $1 and status = 'paid' and paid_at < $2) as balance`,
      [partnerId, at],
    );
    return Number(rows[0]!.balance);
  }

  async nextPayoutCode(year: number): Promise<string> {
    const { rows } = await this.db.query<{ value: string }>(
      `insert into counters (key, value) values ($1, 1)
       on conflict (key) do update set value = counters.value + 1, updated_at = now()
       returning value`,
      [`partner_payout:${year}`],
    );
    return `AF-PPO-${year}-${rows[0]!.value.padStart(6, "0")}`;
  }

  async insertPayout(p: PayoutRecord, entryIds: readonly string[]): Promise<void> {
    await this.db.query(
      `insert into partner_payouts (id, code, partner_id, total_minor, currency, method, reference,
         details, proof_file_ids, notes, status, paid_at, recorded_by, recorded_at, approved_by,
         approved_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        p.id,
        p.code,
        p.partnerId,
        p.totalMinor,
        p.currency,
        p.method,
        p.reference,
        JSON.stringify(p.details),
        p.proofFileIds,
        p.notes,
        p.status,
        p.paidAt,
        p.recordedBy,
        p.recordedAt,
        p.approvedBy,
        p.approvedAt,
      ],
    );
    await this.db.query(
      `insert into partner_payout_items (payout_id, entry_id, amount_minor)
       select $1, id, amount_minor from partner_commission_entries where id = any($2::uuid[])`,
      [p.id, entryIds],
    );
    await this.db.query(
      "update partner_commission_entries set payout_id = $1 where id = any($2::uuid[])",
      [p.id, entryIds],
    );
  }

  async payout(id: string, lock = false): Promise<PayoutRecord | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<PayoutRow>(
      `select * from partner_payouts where id = $1${lock ? " for update" : ""}`,
      [id],
    );
    return rows[0] === undefined ? null : toPayout(rows[0]);
  }

  async savePayout(p: PayoutRecord): Promise<void> {
    await this.db.query(
      `update partner_payouts set status = $2, approved_by = $3, approved_at = $4,
              acknowledged_by = $5, acknowledged_at = $6, reversed_by = $7, reversed_at = $8,
              reversal_reason = $9
        where id = $1`,
      [
        p.id,
        p.status,
        p.approvedBy,
        p.approvedAt,
        p.acknowledgedBy,
        p.acknowledgedAt,
        p.reversedBy,
        p.reversedAt,
        p.reversalReason,
      ],
    );
  }

  async payouts(
    f: Readonly<{
      partnerId?: string;
      status?: PayoutStatus;
      unacknowledged?: boolean;
      limit: number;
    }>,
  ): Promise<PayoutRecord[]> {
    const { rows } = await this.db.query<PayoutRow>(
      `select * from partner_payouts
        where ($1::uuid is null or partner_id = $1) and ($2::text is null or status = $2)
          and (not $3 or (acknowledged_at is null and status = 'paid'))
        order by recorded_at desc, id desc limit $4`,
      [f.partnerId ?? null, f.status ?? null, f.unacknowledged === true, f.limit],
    );
    return rows.map(toPayout);
  }

  async payoutEntries(payoutId: string): Promise<CommissionEntry[]> {
    const { rows } = await this.db.query<EntryRow>(
      `select e.*
         from partner_payout_items i join partner_commission_entries e on e.id = i.entry_id
        where i.payout_id = $1 order by e.created_at, e.id`,
      [payoutId],
    );
    return rows.map(toEntry);
  }

  async markEntriesPaid(payoutId: string): Promise<void> {
    await this.db.query(
      "update partner_commission_entries set status = 'paid' where payout_id = $1",
      [payoutId],
    );
  }

  async releaseEntries(payoutId: string): Promise<void> {
    await this.db.query(
      `update partner_commission_entries set status = 'payable', payout_id = null
        where payout_id = $1`,
      [payoutId],
    );
  }
}
