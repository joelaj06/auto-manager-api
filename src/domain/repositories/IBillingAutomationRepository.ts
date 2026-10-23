import type { DunningPolicy, NoticeChannel } from "../billing/Dunning.js";
import type { BillingDate } from "../billing/Subscription.js";

export type PolicyVersion = Readonly<{
  version: number;
  policy: DunningPolicy;
  createdBy: string | null;
  createdAt: Date;
}>;

/** An unpaid invoice with what the automation needs about its tenant. */
export type DunningCandidate = Readonly<{
  invoiceId: string;
  tenantId: string;
  tenantName: string;
  tenantStatus: string;
  /** Deactivated or read-only by billing (not by staff for another reason). */
  billingStatus: boolean;
  dueOn: BillingDate;
  outstandingMinor: number;
  currency: string;
  branchCount: number;
  everPaid: boolean;
  disputeHold: string | null;
  /** The approved (or expired) extension for this invoice. */
  extendedUntil: BillingDate | null;
}>;

export type NoticeRecord = Readonly<{
  id: string;
  tenantId: string;
  invoiceId: string | null;
  step: string;
  channel: NoticeChannel;
  recipient: string;
  status: "sent" | "failed" | "skipped";
  error: string | null;
  sentAt: Date;
}>;

export type ExtensionStatus = "requested" | "approved" | "denied" | "expired" | "closed";

export type ExtensionRecord = Readonly<{
  id: string;
  tenantId: string;
  invoiceId: string;
  requestedUntil: BillingDate;
  note: string | null;
  status: ExtensionStatus;
  approvedUntil: BillingDate | null;
  requestedBy: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  createdAt: Date;
}>;

export type AutomationRun = Readonly<{
  id: string;
  runOn: BillingDate;
  dryRun: boolean;
  status: "completed" | "halted" | "failed";
  haltReason: string | null;
  invoicesIssued: number;
  noticesSent: number;
  chargesTried: number;
  pastDue: number;
  deactivated: readonly Readonly<Record<string, unknown>>[];
  wouldDeactivate: readonly Readonly<Record<string, unknown>>[];
  heldBack: readonly Readonly<Record<string, unknown>>[];
  startedAt: Date;
  finishedAt: Date | null;
}>;

/** A billing contact or the owner: who receives email and SMS notices. */
export type NoticeRecipient = Readonly<{
  name: string | null;
  email: string | null;
  phone: string | null;
}>;

/** The billing automation's records (platform database, platform unit of work). */
export interface IBillingAutomationRepository {
  policy(): Promise<PolicyVersion>;
  savePolicy(policy: DunningPolicy, staffId: string): Promise<PolicyVersion>;
  policies(limit: number): Promise<PolicyVersion[]>;

  /** Standard subscriptions whose next period starts by `until` and has no invoice yet. */
  subscriptionsToInvoice(today: BillingDate, until: BillingDate): Promise<string[]>;
  /** Every open invoice of a tenant that is not archived. */
  dunningCandidates(): Promise<DunningCandidate[]>;
  /** Trialing, active, past due and read-only tenants. */
  operatingTenants(): Promise<number>;
  failedWebhooksSince(since: Date): Promise<number>;
  /** The latest reconciliation failed (within the last two days). */
  reconciliationFailing(since: Date): Promise<boolean>;
  /** The automation already charged the invoice since `since`. */
  systemChargeSince(invoiceId: string, since: Date): Promise<boolean>;

  /** Billing contacts receiving notices (email or phone). */
  recipients(tenantId: string): Promise<NoticeRecipient[]>;
  /** Takes a notice for sending: false when it was sent before (one per step and recipient). */
  claimNotice(
    notice: Omit<NoticeRecord, "id" | "status" | "error" | "sentAt">,
  ): Promise<string | null>;
  noticeFailed(id: string, error: string): Promise<void>;
  notices(tenantId: string, limit: number): Promise<NoticeRecord[]>;

  setDisputeHold(tenantId: string, reason: string | null): Promise<boolean>;

  addExtension(extension: Omit<ExtensionRecord, "createdAt">): Promise<void>;
  extension(id: string, lock?: boolean): Promise<ExtensionRecord | null>;
  saveExtension(extension: ExtensionRecord): Promise<void>;
  extensions(
    filter: Readonly<{ tenantId?: string; status?: ExtensionStatus; limit: number }>,
  ): Promise<ExtensionRecord[]>;
  /** Extensions approved for the tenant since `since` (the rolling 90-day limit). */
  approvedSince(tenantId: string, since: Date): Promise<number>;
  /** A paid invoice closes its open extension. */
  closeExtensions(invoiceId: string): Promise<void>;
  /** Approved extensions whose date passed become expired; returns how many. */
  expireExtensions(today: BillingDate): Promise<number>;

  startRun(run: Pick<AutomationRun, "id" | "runOn" | "dryRun">): Promise<void>;
  finishRun(run: AutomationRun): Promise<void>;
  runs(limit: number): Promise<AutomationRun[]>;
}
