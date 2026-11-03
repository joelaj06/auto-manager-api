import { DomainError } from "../errors/DomainError.js";

export class SupportRuleError extends DomainError {
  readonly code = "SUPPORT_RULE";
  constructor(message: string) {
    super(message);
  }
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export const TICKET_CATEGORIES = [
  "how_to",
  "technical",
  "billing",
  "data",
  "account",
  "feature_request",
  "other",
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export const TICKET_CHANNELS = ["app", "email", "phone", "whatsapp", "console"] as const;
export type TicketChannel = (typeof TICKET_CHANNELS)[number];
export const TICKET_STATUSES = [
  "open",
  "waiting_on_customer",
  "escalated",
  "resolved",
  "closed",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** A ticket waiting on the customer this long is resolved; a resolved one closed (docs/27 §3.13). */
export const AUTO_RESOLVE_AFTER_DAYS = 7;
export const AUTO_CLOSE_AFTER_DAYS = 7;

export type SlaTarget = Readonly<{
  priority: TicketPriority;
  firstResponseMinutes: number;
  resolutionMinutes: number;
  /** Counted in support hours (docs/35 §1); otherwise around the clock. */
  businessHours: boolean;
}>;

/**
 * Support hours (docs/35 §1): Monday to Saturday, 08:00–18:00 in Accra, which is UTC all year.
 */
export const SUPPORT_HOURS = Object.freeze({ days: [1, 2, 3, 4, 5, 6], startHour: 8, endHour: 18 });

const dayStart = (at: Date, hour: number) =>
  Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), hour);
const isWorkingDay = (at: Date) => SUPPORT_HOURS.days.includes(at.getUTCDay());

/** `minutes` of support hours after `start` (from the next opening when it is closed). */
export function addSupportMinutes(start: Date, minutes: number): Date {
  let cursor = start.getTime();
  let remaining = minutes * MINUTE_MS;
  for (let guard = 0; guard < 3_700; guard++) {
    const day = new Date(cursor);
    const open = dayStart(day, SUPPORT_HOURS.startHour);
    const close = dayStart(day, SUPPORT_HOURS.endHour);
    if (!isWorkingDay(day) || cursor >= close) {
      cursor = dayStart(day, 0) + DAY_MS + SUPPORT_HOURS.startHour * 3_600_000;
      continue;
    }
    if (cursor < open) cursor = open;
    if (remaining <= close - cursor) return new Date(cursor + remaining);
    remaining -= close - cursor;
    cursor = dayStart(day, 0) + DAY_MS + SUPPORT_HOURS.startHour * 3_600_000;
  }
  throw new Error("Support hours never reach the target");
}

/** The support-hour minutes between two times. */
export function supportMinutesBetween(from: Date, to: Date): number {
  let total = 0;
  let cursor = from.getTime();
  const end = to.getTime();
  while (cursor < end) {
    const day = new Date(cursor);
    const next = dayStart(day, 0) + DAY_MS;
    if (isWorkingDay(day)) {
      const open = dayStart(day, SUPPORT_HOURS.startHour);
      const close = dayStart(day, SUPPORT_HOURS.endHour);
      total += Math.max(0, Math.min(close, end) - Math.max(open, cursor));
    }
    cursor = next;
  }
  return Math.round(total / MINUTE_MS);
}

const after = (start: Date, minutes: number, businessHours: boolean) =>
  businessHours ? addSupportMinutes(start, minutes) : addMinutes(start, minutes);
export type SlaTargets = Readonly<Record<TicketPriority, SlaTarget>>;

/** Checks the SLA targets staff set: whole minutes, resolution no sooner than the first answer. */
export function checkSlaTarget(target: SlaTarget): SlaTarget {
  const { firstResponseMinutes: first, resolutionMinutes: resolution } = target;
  if (!Number.isInteger(first) || first < 5 || first > 20_160)
    throw new SupportRuleError("The first response target is 5 minutes to 14 days");
  if (!Number.isInteger(resolution) || resolution < 15 || resolution > 86_400)
    throw new SupportRuleError("The resolution target is 15 minutes to 60 days");
  if (resolution < first)
    throw new SupportRuleError("The resolution target cannot be sooner than the first response");
  return target;
}

export type Escalation = Readonly<{
  requestId: string | null;
  sentryUrl: string | null;
  note: string;
  by: string;
  at: string;
}>;

export type SupportTicketProps = {
  id: string;
  number: string;
  tenantId: string | null;
  tenantUserId: string | null;
  requesterName: string;
  requesterEmail: string | null;
  requesterPhone: string | null;
  channel: TicketChannel;
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  businessHours: boolean;
  assigneeId: string | null;
  dataProtectionRequestId: string | null;
  firstResponseDueAt: Date;
  resolutionDueAt: Date;
  firstRespondedAt: Date | null;
  firstResponseBreachedAt: Date | null;
  resolutionBreachedAt: Date | null;
  pausedAt: Date | null;
  escalation: Escalation | null;
  escalatedAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  satisfaction: number | null;
  satisfactionComment: string | null;
  ratedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
};

export type NewTicket = Readonly<{
  id: string;
  number: string;
  tenantId: string | null;
  tenantUserId: string | null;
  requesterName: string;
  requesterEmail: string | null;
  requesterPhone: string | null;
  channel: TicketChannel;
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  createdBy: string | null;
}>;

/** What the SLA sweep found on a ticket. */
export type SlaBreach = "first_response" | "resolution";

const ACTIVE: readonly TicketStatus[] = ["open", "waiting_on_customer", "escalated"];
const addMinutes = (at: Date, minutes: number) => new Date(at.getTime() + minutes * MINUTE_MS);

/**
 * A support ticket (docs/27 §3.13, decision 500):
 *
 *   open ⇄ waiting_on_customer (the resolution clock stops) · open ⇄ escalated (to engineering)
 *   → resolved (reopened by a customer reply within 7 days) → closed
 *
 * SLA timers run from when it was raised, in support hours (docs/35 §1) or around the clock for
 * urgent tickets: a first public reply by staff before the first-response target, and
 * resolution before the resolution target, moved on by the time spent waiting on the customer.
 * A breach is recorded once, when the sweep sees it.
 */
export class SupportTicket {
  private constructor(private props: SupportTicketProps) {}

  static raise(input: NewTicket, targets: SlaTargets, now: Date): SupportTicket {
    const target = targets[input.priority];
    if (
      input.requesterEmail === null &&
      input.requesterPhone === null &&
      input.tenantUserId === null
    )
      throw new SupportRuleError("Give the requester's email or phone to answer them");
    if (input.tenantUserId !== null && input.tenantId === null)
      throw new SupportRuleError("A tenant user belongs to a tenant");
    return new SupportTicket({
      ...input,
      status: "open",
      businessHours: target.businessHours,
      assigneeId: null,
      dataProtectionRequestId: null,
      firstResponseDueAt: after(now, target.firstResponseMinutes, target.businessHours),
      resolutionDueAt: after(now, target.resolutionMinutes, target.businessHours),
      firstRespondedAt: null,
      firstResponseBreachedAt: null,
      resolutionBreachedAt: null,
      pausedAt: null,
      escalation: null,
      escalatedAt: null,
      resolvedAt: null,
      closedAt: null,
      satisfaction: null,
      satisfactionComment: null,
      ratedAt: null,
      createdAt: now,
    });
  }

  static restore(props: SupportTicketProps): SupportTicket {
    return new SupportTicket({ ...props });
  }

  get id(): string {
    return this.props.id;
  }

  get status(): TicketStatus {
    return this.props.status;
  }

  snapshot(): Readonly<SupportTicketProps> {
    return { ...this.props };
  }

  /** A staff reply; public ones count as the first response and usually wait on the customer. */
  staffReplied(
    internal: boolean,
    next: "open" | "waiting_on_customer" | "resolved" | null,
    now: Date,
  ): void {
    if (this.props.status === "closed")
      throw new SupportRuleError("The ticket is closed; open a new one");
    if (internal) return;
    if (this.props.firstRespondedAt === null) this.props.firstRespondedAt = now;
    const to = next ?? (this.props.status === "escalated" ? "escalated" : "waiting_on_customer");
    this.moveTo(to, now);
  }

  /** The customer wrote: back to staff, and a resolved ticket reopens. */
  customerReplied(now: Date): void {
    if (this.props.status === "closed")
      throw new SupportRuleError("The ticket is closed; raise a new one");
    if (this.props.status === "waiting_on_customer" || this.props.status === "resolved")
      this.moveTo("open", now);
  }

  escalate(escalation: Escalation, now: Date): void {
    if (!ACTIVE.includes(this.props.status))
      throw new SupportRuleError("Only an open ticket can be escalated");
    this.props.escalation = escalation;
    this.props.escalatedAt = now;
    this.moveTo("escalated", now);
  }

  /** Staff change the status: open again, resolved or closed. */
  setStatus(to: "open" | "resolved" | "closed", now: Date): void {
    if (this.props.status === "closed") throw new SupportRuleError("The ticket is closed");
    if (to === this.props.status) return;
    this.moveTo(to, now);
  }

  /**
   * A new priority moves the targets, counted from when the ticket was raised; time already spent
   * waiting on the customer still moves the resolution target on. Breaches already recorded stay.
   */
  reprioritise(priority: TicketPriority, targets: SlaTargets): void {
    const p = this.props;
    if (priority === p.priority) return;
    const target = targets[priority];
    const waited =
      p.resolutionDueAt.getTime() -
      after(p.createdAt, targets[p.priority].resolutionMinutes, p.businessHours).getTime();
    p.priority = priority;
    p.businessHours = target.businessHours;
    p.firstResponseDueAt = after(p.createdAt, target.firstResponseMinutes, target.businessHours);
    p.resolutionDueAt = new Date(
      after(p.createdAt, target.resolutionMinutes, target.businessHours).getTime() +
        Math.max(0, waited),
    );
  }

  assign(staffId: string | null): void {
    this.props.assigneeId = staffId;
  }

  categorise(category: TicketCategory): void {
    this.props.category = category;
  }

  /** Links a ticket logged without one to the tenant it is about. */
  linkTenant(tenantId: string | null): void {
    if (this.props.tenantUserId !== null && tenantId !== this.props.tenantId)
      throw new SupportRuleError("A ticket raised in the app stays with its tenant");
    this.props.tenantId = tenantId;
  }

  linkRequest(requestId: string | null): void {
    this.props.dataProtectionRequestId = requestId;
  }

  /** The requester rates the answer once it is resolved: 1–5 with an optional comment. */
  rate(score: number, comment: string | null, now: Date): void {
    if (this.props.status !== "resolved" && this.props.status !== "closed")
      throw new SupportRuleError("Rate a ticket once it is resolved");
    if (this.props.ratedAt !== null) throw new SupportRuleError("This ticket is already rated");
    if (!Number.isInteger(score) || score < 1 || score > 5)
      throw new SupportRuleError("The rating is 1 to 5");
    this.props.satisfaction = score;
    this.props.satisfactionComment = comment;
    this.props.ratedAt = now;
  }

  /** The SLA breaches not recorded yet, recorded now. */
  checkSla(now: Date): SlaBreach[] {
    const breaches: SlaBreach[] = [];
    const p = this.props;
    if (!ACTIVE.includes(p.status)) return breaches;
    if (
      p.firstRespondedAt === null &&
      p.firstResponseBreachedAt === null &&
      now > p.firstResponseDueAt
    ) {
      p.firstResponseBreachedAt = now;
      breaches.push("first_response");
    }
    if (
      p.status !== "waiting_on_customer" &&
      p.resolutionBreachedAt === null &&
      now > p.resolutionDueAt
    ) {
      p.resolutionBreachedAt = now;
      breaches.push("resolution");
    }
    return breaches;
  }

  /** What the sweep does with a quiet ticket: resolve one left waiting, close one resolved. */
  housekeeping(now: Date): "resolved" | "closed" | null {
    const p = this.props;
    if (p.status === "waiting_on_customer" && p.pausedAt !== null) {
      if (now.getTime() - p.pausedAt.getTime() >= AUTO_RESOLVE_AFTER_DAYS * DAY_MS) {
        this.moveTo("resolved", now);
        return "resolved";
      }
    } else if (p.status === "resolved" && p.resolvedAt !== null) {
      if (now.getTime() - p.resolvedAt.getTime() >= AUTO_CLOSE_AFTER_DAYS * DAY_MS) {
        this.moveTo("closed", now);
        return "closed";
      }
    }
    return null;
  }

  private moveTo(to: TicketStatus, now: Date): void {
    const p = this.props;
    if (p.status === to) return;
    // Leaving "waiting on the customer": the time waited is added to the resolution target.
    if (p.status === "waiting_on_customer" && p.pausedAt !== null) {
      p.resolutionDueAt = p.businessHours
        ? addSupportMinutes(p.resolutionDueAt, supportMinutesBetween(p.pausedAt, now))
        : new Date(p.resolutionDueAt.getTime() + Math.max(0, now.getTime() - p.pausedAt.getTime()));
      p.pausedAt = null;
    }
    if (to === "waiting_on_customer") p.pausedAt = now;
    if (to === "resolved") p.resolvedAt = now;
    if (to === "closed") {
      p.resolvedAt ??= now;
      p.closedAt = now;
    }
    if (to === "open" || to === "escalated" || to === "waiting_on_customer") p.resolvedAt = null;
    p.status = to;
  }
}

/** Fills a canned response's placeholders; unknown ones are left as they are. */
export function renderCanned(
  body: string,
  values: Readonly<{
    requesterName: string;
    ticketNumber: string;
    staffName: string;
    businessName: string | null;
  }>,
): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    switch (key) {
      case "requesterName":
        return values.requesterName;
      case "ticketNumber":
        return values.ticketNumber;
      case "staffName":
        return values.staffName;
      case "businessName":
        return values.businessName ?? "your business";
      default:
        return match;
    }
  });
}

/** An engineering link: an https address (Sentry or the error tracker). */
export function checkEscalationLink(url: string | null): string | null {
  if (url === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SupportRuleError("The link is not a web address");
  }
  if (parsed.protocol !== "https:") throw new SupportRuleError("The link must be https");
  return parsed.toString();
}
