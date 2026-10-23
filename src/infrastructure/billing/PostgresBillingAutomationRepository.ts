import type { DunningPolicy, NoticeChannel } from "../../domain/billing/Dunning.js";
import type {
  AutomationRun,
  DunningCandidate,
  ExtensionRecord,
  ExtensionStatus,
  IBillingAutomationRepository,
  NoticeRecipient,
  NoticeRecord,
  PolicyVersion,
} from "../../domain/repositories/IBillingAutomationRepository.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

/** Policies saved before a field existed lack it. */
type StoredPolicy = Omit<DunningPolicy, "skipSundays"> &
  Partial<Pick<DunningPolicy, "skipSundays">>;
type PolicyRow = {
  version: number;
  policy: StoredPolicy;
  created_by: string | null;
  created_at: Date;
};
type ExtensionRow = {
  id: string;
  tenant_id: string;
  invoice_id: string;
  requested_until: string;
  note: string | null;
  status: ExtensionStatus;
  approved_until: string | null;
  requested_by: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  created_at: Date;
};
type RunRow = {
  id: string;
  run_on: string;
  dry_run: boolean;
  status: AutomationRun["status"];
  halt_reason: string | null;
  invoices_issued: number;
  notices_sent: number;
  charges_tried: number;
  past_due: number;
  deactivated: AutomationRun["deactivated"];
  would_deactivate: AutomationRun["wouldDeactivate"];
  held_back: AutomationRun["heldBack"];
  started_at: Date;
  finished_at: Date | null;
};

const toPolicy = (r: PolicyRow): PolicyVersion => ({
  version: r.version,
  policy: { ...r.policy, skipSundays: r.policy.skipSundays ?? false },
  createdBy: r.created_by,
  createdAt: r.created_at,
});

const toExtension = (r: ExtensionRow): ExtensionRecord => ({
  id: r.id,
  tenantId: r.tenant_id,
  invoiceId: r.invoice_id,
  requestedUntil: r.requested_until,
  note: r.note,
  status: r.status,
  approvedUntil: r.approved_until,
  requestedBy: r.requested_by,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
  decisionReason: r.decision_reason,
  createdAt: r.created_at,
});

const toRun = (r: RunRow): AutomationRun => ({
  id: r.id,
  runOn: r.run_on,
  dryRun: r.dry_run,
  status: r.status,
  haltReason: r.halt_reason,
  invoicesIssued: r.invoices_issued,
  noticesSent: r.notices_sent,
  chargesTried: r.charges_tried,
  pastDue: r.past_due,
  deactivated: r.deactivated,
  wouldDeactivate: r.would_deactivate,
  heldBack: r.held_back,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

const EXTENSION_COLUMNS = `id, tenant_id, invoice_id, requested_until::text, note, status,
  approved_until::text, requested_by, decided_by, decided_at, decision_reason, created_at`;
const RUN_COLUMNS = `id, run_on::text, dry_run, status, halt_reason, invoices_issued, notices_sent,
  charges_tried, past_due, deactivated, would_deactivate, held_back, started_at, finished_at`;

/** The next period's start, as `Subscription.nextPeriod` computes it (dates in Africa/Accra). */
const NEXT_START = `coalesce(s.current_period_end,
  greatest(coalesce((s.trial_ends_at at time zone 'Africa/Accra')::date, $1::date), $1::date))`;

export class PostgresBillingAutomationRepository implements IBillingAutomationRepository {
  constructor(private readonly db: PlatformDb) {}

  async policy(): Promise<PolicyVersion> {
    const { rows } = await this.db.query<PolicyRow>(
      "select * from dunning_policies order by version desc limit 1",
    );
    return toPolicy(rows[0]!);
  }

  async savePolicy(policy: DunningPolicy, staffId: string): Promise<PolicyVersion> {
    const { rows } = await this.db.query<PolicyRow>(
      `insert into dunning_policies (version, policy, created_by)
       select coalesce(max(version), 0) + 1, $1, $2 from dunning_policies
       returning *`,
      [JSON.stringify(policy), staffId],
    );
    return toPolicy(rows[0]!);
  }

  async policies(limit: number): Promise<PolicyVersion[]> {
    const { rows } = await this.db.query<PolicyRow>(
      "select * from dunning_policies order by version desc limit $1",
      [limit],
    );
    return rows.map(toPolicy);
  }

  async subscriptionsToInvoice(today: string, until: string): Promise<string[]> {
    const { rows } = await this.db.query<{ tenant_id: string }>(
      `select s.tenant_id
         from subscriptions s
         join plans p on p.id = s.plan_id
         join tenants t on t.id = s.tenant_id
        -- Priced: the standard price list, or an enterprise tenant's accepted quote.
        where ((p.pricing = 'flat_per_branch' and p.branch_price_minor is not null)
               or (p.pricing = 'custom' and exists (
                     select 1 from subscription_price_items pi
                      where pi.subscription_id = s.id and pi.ended_at is null
                        and pi.recurrence = 'monthly')))
          and s.status in ('trialing', 'active', 'past_due')
          and t.status in ('trialing', 'active', 'past_due', 'read_only')
          and ${NEXT_START} <= $2::date
          -- One invoice per period: none open, and staff did not void this period's.
          and not exists (select 1 from billing_invoices i
                           where i.subscription_id = s.id
                             and (i.status = 'open' or i.period_start = ${NEXT_START}))
        order by s.tenant_id`,
      [today, until],
    );
    return rows.map((r) => r.tenant_id);
  }

  async dunningCandidates(): Promise<DunningCandidate[]> {
    const { rows } = await this.db.query<{
      invoice_id: string;
      tenant_id: string;
      tenant_name: string;
      tenant_status: string;
      billing_status: boolean;
      due_on: string;
      outstanding_minor: string;
      currency: string;
      branch_count: number;
      ever_paid: boolean;
      dispute_hold_reason: string | null;
      extended_until: string | null;
    }>(
      `select i.id as invoice_id, i.tenant_id, t.name as tenant_name, t.status as tenant_status,
              coalesce(t.deactivation_reason in ('non_payment', 'trial_expired'), false)
                as billing_status,
              (i.due_at at time zone 'Africa/Accra')::date::text as due_on,
              i.total_minor - i.paid_minor as outstanding_minor, i.currency, s.branch_count,
              s.licence_locked_at is not null as ever_paid, s.dispute_hold_reason,
              (select e.approved_until::text from billing_extensions e
                where e.invoice_id = i.id and e.status in ('approved', 'expired')
                order by e.created_at desc limit 1) as extended_until
         from billing_invoices i
         join tenants t on t.id = i.tenant_id
         join subscriptions s on s.id = i.subscription_id
        where i.status = 'open'
          and t.status in ('trialing', 'active', 'past_due', 'read_only', 'deactivated')
        order by due_on, i.id`,
    );
    return rows.map((r) => ({
      invoiceId: r.invoice_id,
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      tenantStatus: r.tenant_status,
      billingStatus: r.billing_status,
      dueOn: r.due_on,
      outstandingMinor: Number(r.outstanding_minor),
      currency: r.currency,
      branchCount: r.branch_count,
      everPaid: r.ever_paid,
      disputeHold: r.dispute_hold_reason,
      extendedUntil: r.extended_until,
    }));
  }

  async operatingTenants(): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      `select count(*)::int as n from tenants
        where status in ('trialing', 'active', 'past_due', 'read_only')`,
    );
    return rows[0]!.n;
  }

  async failedWebhooksSince(since: Date): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      "select count(*)::int as n from webhook_events where outcome = 'failed' and received_at >= $1",
      [since],
    );
    return rows[0]!.n;
  }

  async reconciliationFailing(since: Date): Promise<boolean> {
    const { rows } = await this.db.query<{ status: string }>(
      `select status from gateway_reconciliations where ran_at >= $1
        order by ran_at desc limit 1`,
      [since],
    );
    return rows[0]?.status === "failed";
  }

  async systemChargeSince(invoiceId: string, since: Date): Promise<boolean> {
    const { rows } = await this.db.query(
      `select 1 from gateway_transactions
        where invoice_id = $1 and initiated_by_type = 'system' and created_at >= $2 limit 1`,
      [invoiceId, since],
    );
    return rows.length > 0;
  }

  async recipients(tenantId: string): Promise<NoticeRecipient[]> {
    const { rows } = await this.db.query<NoticeRecipient>(
      `select name, email::text as email, phone from billing_contacts
        where tenant_id = $1 and receives_notices order by is_primary desc, created_at`,
      [tenantId],
    );
    return rows;
  }

  async claimNotice(
    n: Omit<NoticeRecord, "id" | "status" | "error" | "sentAt">,
  ): Promise<string | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `insert into billing_notices (tenant_id, invoice_id, step, channel, recipient, status)
       values ($1, $2, $3, $4, $5, 'sent')
       on conflict do nothing returning id`,
      [n.tenantId, n.invoiceId, n.step, n.channel, n.recipient.slice(0, 200)],
    );
    return rows[0]?.id ?? null;
  }

  async noticeFailed(id: string, error: string): Promise<void> {
    await this.db.query("update billing_notices set status = 'failed', error = $2 where id = $1", [
      id,
      error.slice(0, 500),
    ]);
  }

  async notices(tenantId: string, limit: number): Promise<NoticeRecord[]> {
    const { rows } = await this.db.query<{
      id: string;
      tenant_id: string;
      invoice_id: string | null;
      step: string;
      channel: NoticeChannel;
      recipient: string;
      status: NoticeRecord["status"];
      error: string | null;
      sent_at: Date;
    }>(
      `select * from billing_notices where tenant_id = $1 order by sent_at desc, id desc limit $2`,
      [tenantId, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      invoiceId: r.invoice_id,
      step: r.step,
      channel: r.channel,
      recipient: r.recipient,
      status: r.status,
      error: r.error,
      sentAt: r.sent_at,
    }));
  }

  async setDisputeHold(tenantId: string, reason: string | null): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `update subscriptions set dispute_hold = $2::text is not null, dispute_hold_reason = $2,
              updated_at = now()
        where tenant_id = $1`,
      [tenantId, reason],
    );
    return rowCount === 1;
  }

  async addExtension(e: Omit<ExtensionRecord, "createdAt">): Promise<void> {
    await this.db.query(
      `insert into billing_extensions (id, tenant_id, invoice_id, requested_until, note, status,
         approved_until, requested_by, decided_by, decided_at, decision_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        e.id,
        e.tenantId,
        e.invoiceId,
        e.requestedUntil,
        e.note,
        e.status,
        e.approvedUntil,
        e.requestedBy,
        e.decidedBy,
        e.decidedAt,
        e.decisionReason,
      ],
    );
  }

  async extension(id: string, lock = false): Promise<ExtensionRecord | null> {
    const { rows } = await this.db.query<ExtensionRow>(
      `select ${EXTENSION_COLUMNS} from billing_extensions where id = $1${lock ? " for update" : ""}`,
      [id],
    );
    return rows[0] === undefined ? null : toExtension(rows[0]);
  }

  async saveExtension(e: ExtensionRecord): Promise<void> {
    await this.db.query(
      `update billing_extensions set status = $2, approved_until = $3, decided_by = $4,
              decided_at = $5, decision_reason = $6
        where id = $1`,
      [e.id, e.status, e.approvedUntil, e.decidedBy, e.decidedAt, e.decisionReason],
    );
  }

  async extensions(
    filter: Readonly<{ tenantId?: string; status?: ExtensionStatus; limit: number }>,
  ): Promise<ExtensionRecord[]> {
    const { rows } = await this.db.query<ExtensionRow>(
      `select ${EXTENSION_COLUMNS} from billing_extensions
        where ($1::uuid is null or tenant_id = $1) and ($2::text is null or status = $2)
        order by created_at desc limit $3`,
      [filter.tenantId ?? null, filter.status ?? null, filter.limit],
    );
    return rows.map(toExtension);
  }

  async approvedSince(tenantId: string, since: Date): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      `select count(*)::int as n from billing_extensions
        where tenant_id = $1 and approved_until is not null and decided_at >= $2`,
      [tenantId, since],
    );
    return rows[0]!.n;
  }

  async closeExtensions(invoiceId: string): Promise<void> {
    await this.db.query(
      `update billing_extensions set status = 'closed'
        where invoice_id = $1 and status in ('requested', 'approved')`,
      [invoiceId],
    );
  }

  async expireExtensions(today: string): Promise<number> {
    const { rowCount } = await this.db.query(
      `update billing_extensions set status = 'expired'
        where status = 'approved' and approved_until < $1::date`,
      [today],
    );
    return rowCount ?? 0;
  }

  async startRun(run: Pick<AutomationRun, "id" | "runOn" | "dryRun">): Promise<void> {
    await this.db.query(
      `insert into billing_automation_runs (id, run_on, dry_run, status) values ($1, $2, $3, 'failed')`,
      [run.id, run.runOn, run.dryRun],
    );
  }

  async finishRun(r: AutomationRun): Promise<void> {
    await this.db.query(
      `update billing_automation_runs set status = $2, halt_reason = $3, invoices_issued = $4,
              notices_sent = $5, charges_tried = $6, past_due = $7, deactivated = $8,
              would_deactivate = $9, held_back = $10, finished_at = $11
        where id = $1`,
      [
        r.id,
        r.status,
        r.haltReason,
        r.invoicesIssued,
        r.noticesSent,
        r.chargesTried,
        r.pastDue,
        JSON.stringify(r.deactivated),
        JSON.stringify(r.wouldDeactivate),
        JSON.stringify(r.heldBack),
        r.finishedAt,
      ],
    );
  }

  async runs(limit: number): Promise<AutomationRun[]> {
    const { rows } = await this.db.query<RunRow>(
      `select ${RUN_COLUMNS} from billing_automation_runs order by started_at desc limit $1`,
      [limit],
    );
    return rows.map(toRun);
  }
}
