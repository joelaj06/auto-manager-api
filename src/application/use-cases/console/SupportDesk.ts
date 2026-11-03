import { DomainError } from "../../../domain/errors/DomainError.js";
import { randomUUID } from "node:crypto";
import {
  checkEscalationLink,
  checkSlaTarget,
  renderCanned,
  SupportRuleError,
  SupportTicket,
  type SlaTarget,
  type SlaTargets,
  type TicketCategory,
  type TicketChannel,
  type TicketPriority,
  type TicketStatus,
} from "../../../domain/console/SupportDesk.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { NotificationService } from "../../notifications/NotificationService.js";
import type { IClock } from "../../ports/IClock.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type {
  CannedResponse,
  CannedResponseInput,
  ISupportDesk,
  SupportSummary,
  TicketFilter,
  TicketMessage,
  TicketView,
} from "../../ports/ISupportDesk.js";
import type { IAlerts } from "./PlatformAlerts.js";

const DAY_MS = 86_400_000;

export class SupportTicketNotFoundError extends DomainError {
  readonly code = "SUPPORT_TICKET_NOT_FOUND";
  constructor() {
    super("No such ticket");
  }
}

export type TicketWithMessages = Readonly<{ ticket: TicketView; messages: TicketMessage[] }>;

/** The signed-in tenant user raising or following a ticket in the app. */
export type Requester = Readonly<{
  tenantId: string;
  userId: string;
  /** May see every ticket of the business (`support.tickets.view_all`), not only their own. */
  seesAll: boolean;
}>;

export type LogTicketInput = Readonly<{
  tenantId: string | null;
  tenantUserId: string | null;
  requesterName: string;
  requesterEmail: string | null;
  requesterPhone: string | null;
  channel: Exclude<TicketChannel, "app">;
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  body: string;
  /** Email the requester that it was received. */
  acknowledge: boolean;
}>;

export type ReplyInput = Readonly<{
  body?: string | null;
  cannedResponseId?: string | null;
  internal: boolean;
  status?: "open" | "waiting_on_customer" | "resolved" | null;
}>;

export type TicketChanges = Readonly<{
  priority?: TicketPriority;
  category?: TicketCategory;
  assigneeId?: string | null;
  tenantId?: string | null;
  dataProtectionRequestId?: string | null;
}>;

type Deps = Readonly<{
  unitOfWork: IPlatformUnitOfWork;
  desk: ISupportDesk;
  notifications: NotificationService;
  audit: IPlatformAuditTrail;
  clock: IClock;
  logger: ILogger;
  /** The tenant user raising a ticket, read from their tenant's database. */
  requesterOf: (
    tenantId: string,
    userId: string,
  ) => Promise<Readonly<{ name: string; email: string | null; phone: string | null }> | null>;
  /** Where the requester follows the ticket in the web app (tickets raised there). */
  ticketUrl: (tenantSlug: string, ticketId: string) => string;
}>;

/**
 * The support desk (docs/27 §3.13, decision 500): tickets raised in the app or logged by staff
 * from a call, email or WhatsApp message, answered with replies and internal notes (canned
 * responses fill their placeholders), escalated to engineering with the request id and the
 * Sentry link, linked to the tenant, its user and a data-protection request, with SLA timers per
 * priority and a satisfaction rating once resolved. Requesters are emailed when staff answer.
 */
export class SupportDesk {
  constructor(private readonly deps: Deps) {}

  // --- staff ---

  list(filter: TicketFilter): Promise<TicketView[]> {
    return this.deps.desk.list(filter);
  }

  async ticket(id: string): Promise<TicketWithMessages> {
    const ticket = await this.deps.desk.find(id);
    if (ticket === null) throw new SupportTicketNotFoundError();
    return { ticket, messages: await this.deps.desk.messages(id, true) };
  }

  summary(days: number): Promise<SupportSummary> {
    const now = this.deps.clock.now();
    return this.deps.desk.summary(new Date(now.getTime() - days * DAY_MS), now);
  }

  /** A ticket from a call, an email or a WhatsApp message, with what the requester said. */
  async log(actor: PlatformPrincipal, input: LogTicketInput): Promise<TicketView> {
    const { deps } = this;
    const ticket = await this.raise(
      {
        tenantId: input.tenantId,
        tenantUserId: input.tenantUserId,
        requesterName: input.requesterName.trim(),
        requesterEmail: input.requesterEmail,
        requesterPhone: input.requesterPhone,
        channel: input.channel,
        subject: input.subject.trim(),
        category: input.category,
        priority: input.priority,
        createdBy: actor.userId,
      },
      input.body,
    );
    await deps.audit.record({
      actorType: "platform_staff",
      actorId: actor.userId,
      action: "support.ticket_logged",
      entityType: "support_ticket",
      entityId: ticket.id,
      targetTenantId: ticket.tenantId,
      after: { number: ticket.number, channel: ticket.channel, priority: ticket.priority },
    });
    if (input.acknowledge) await this.acknowledge(ticket);
    return ticket;
  }

  /** A reply to the requester (emailed to them) or an internal note for staff. */
  async reply(
    actor: PlatformPrincipal,
    id: string,
    input: ReplyInput,
  ): Promise<TicketWithMessages> {
    const { deps } = this;
    let canned: CannedResponse | null = null;
    if (input.cannedResponseId !== undefined && input.cannedResponseId !== null) {
      canned = await deps.desk.cannedResponse(input.cannedResponseId);
      if (canned === null || !canned.active)
        throw new SupportRuleError("No such canned response in use");
    }
    const view = await this.require(id);
    const written = input.body?.trim() ?? "";
    const body =
      written !== ""
        ? written
        : canned === null
          ? ""
          : renderCanned(canned.body, {
              requesterName: view.requesterName,
              ticketNumber: view.number,
              staffName: actor.name,
              businessName: view.tenantName,
            });
    if (body === "") throw new SupportRuleError("Write a reply or choose a canned response");

    await deps.unitOfWork.run(async () => {
      const ticket = await this.lock(id);
      ticket.staffReplied(input.internal, input.status ?? null, deps.clock.now());
      await deps.desk.save(ticket);
      await deps.desk.addMessage({
        ticketId: id,
        authorType: "staff",
        authorStaffId: actor.userId,
        authorName: actor.name,
        body,
        internal: input.internal,
        cannedResponseId: canned?.id ?? null,
      });
      if (canned !== null) await deps.desk.cannedUsed(canned.id);
    });
    const after = await this.require(id);
    if (!input.internal) await this.emailReply(after, actor.name, body);
    return { ticket: after, messages: await deps.desk.messages(id, true) };
  }

  /** To engineering, with what they need to find the failure (decision 500). */
  async escalate(
    actor: PlatformPrincipal,
    id: string,
    input: Readonly<{ requestId: string | null; sentryUrl: string | null; note: string }>,
  ): Promise<TicketView> {
    const { deps } = this;
    const sentryUrl = checkEscalationLink(input.sentryUrl);
    const now = deps.clock.now();
    await deps.unitOfWork.run(async () => {
      const ticket = await this.lock(id);
      ticket.escalate(
        {
          requestId: input.requestId,
          sentryUrl,
          note: input.note.trim(),
          by: actor.name,
          at: now.toISOString(),
        },
        now,
      );
      await deps.desk.save(ticket);
      await deps.desk.addMessage({
        ticketId: id,
        authorType: "staff",
        authorStaffId: actor.userId,
        authorName: actor.name,
        body: [
          `Escalated to engineering: ${input.note.trim()}`,
          ...(input.requestId === null ? [] : [`Request id: ${input.requestId}`]),
          ...(sentryUrl === null ? [] : [`Sentry: ${sentryUrl}`]),
        ].join("\n"),
        internal: true,
        cannedResponseId: null,
      });
      await this.audited(actor, "support.ticket_escalated", ticket, {
        requestId: input.requestId,
        sentryUrl,
      });
    });
    return this.require(id);
  }

  async setStatus(
    actor: PlatformPrincipal,
    id: string,
    input: Readonly<{ status: "open" | "resolved" | "closed"; note: string | null }>,
  ): Promise<TicketView> {
    const { deps } = this;
    let from = "open" as TicketStatus;
    await deps.unitOfWork.run(async () => {
      const ticket = await this.lock(id);
      from = ticket.status;
      ticket.setStatus(input.status, deps.clock.now());
      await deps.desk.save(ticket);
      if (input.note !== null && input.note.trim() !== "")
        await deps.desk.addMessage({
          ticketId: id,
          authorType: "staff",
          authorStaffId: actor.userId,
          authorName: actor.name,
          body: input.note.trim(),
          internal: true,
          cannedResponseId: null,
        });
      await this.audited(actor, "support.ticket_status_changed", ticket, {
        from,
        to: input.status,
      });
    });
    const after = await this.require(id);
    if (input.status === "resolved" && from !== "resolved") await this.emailResolved(after);
    return after;
  }

  async update(actor: PlatformPrincipal, id: string, changes: TicketChanges): Promise<TicketView> {
    const { deps } = this;
    if (
      changes.dataProtectionRequestId !== undefined &&
      changes.dataProtectionRequestId !== null &&
      !(await deps.desk.requestExists(changes.dataProtectionRequestId))
    )
      throw new SupportRuleError("No such data-protection request");
    if (
      changes.assigneeId !== undefined &&
      changes.assigneeId !== null &&
      (await deps.desk.staffName(changes.assigneeId)) === null
    )
      throw new SupportRuleError("No such staff member");
    if (
      changes.tenantId !== undefined &&
      changes.tenantId !== null &&
      (await deps.desk.tenantName(changes.tenantId)) === null
    )
      throw new SupportRuleError("No such tenant");
    const targets = await deps.desk.slaTargets();
    await deps.unitOfWork.run(async () => {
      const ticket = await this.lock(id);
      const before = ticket.snapshot();
      if (changes.priority !== undefined) ticket.reprioritise(changes.priority, targets);
      if (changes.category !== undefined) ticket.categorise(changes.category);
      if (changes.assigneeId !== undefined) ticket.assign(changes.assigneeId);
      if (changes.tenantId !== undefined) ticket.linkTenant(changes.tenantId);
      if (changes.dataProtectionRequestId !== undefined)
        ticket.linkRequest(changes.dataProtectionRequestId);
      await deps.desk.save(ticket);
      await this.audited(actor, "support.ticket_updated", ticket, {
        ...changes,
        from: {
          priority: before.priority,
          category: before.category,
          assigneeId: before.assigneeId,
          tenantId: before.tenantId,
        },
      });
    });
    return this.require(id);
  }

  // --- canned responses and SLA targets ---

  cannedResponses(activeOnly: boolean): Promise<CannedResponse[]> {
    return this.deps.desk.cannedResponses(activeOnly);
  }

  async createCanned(
    actor: PlatformPrincipal,
    input: CannedResponseInput,
  ): Promise<CannedResponse> {
    const created = await this.deps.desk.createCanned(clean(input), actor.userId);
    await this.deps.audit.record({
      actorType: "platform_staff",
      actorId: actor.userId,
      action: "support.canned_response_created",
      entityType: "canned_response",
      entityId: created.id,
      after: { title: created.title },
    });
    return created;
  }

  async updateCanned(
    actor: PlatformPrincipal,
    id: string,
    input: CannedResponseInput,
  ): Promise<CannedResponse> {
    const updated = await this.deps.desk.updateCanned(id, clean(input), actor.userId);
    if (updated === null) throw new SupportRuleError("No such canned response");
    await this.deps.audit.record({
      actorType: "platform_staff",
      actorId: actor.userId,
      action: "support.canned_response_updated",
      entityType: "canned_response",
      entityId: id,
      after: { title: updated.title, active: updated.active },
    });
    return updated;
  }

  slaTargets(): Promise<SlaTargets> {
    return this.deps.desk.slaTargets();
  }

  /** New targets apply to tickets raised from now on. */
  async setSlaTarget(actor: PlatformPrincipal, target: SlaTarget): Promise<SlaTargets> {
    const before = (await this.deps.desk.slaTargets())[target.priority];
    await this.deps.desk.setSlaTarget(checkSlaTarget(target), actor.userId);
    await this.deps.audit.record({
      actorType: "platform_staff",
      actorId: actor.userId,
      action: "support.sla_changed",
      entityType: "support_sla",
      entityId: target.priority,
      before,
      after: target,
    });
    return this.deps.desk.slaTargets();
  }

  // --- the tenant's users ---

  async raiseInApp(
    requester: Requester & Readonly<{ tenantSlug: string }>,
    input: Readonly<{
      subject: string;
      category: TicketCategory;
      priority: Exclude<TicketPriority, "urgent">;
      body: string;
    }>,
  ): Promise<TicketWithMessages> {
    const who = await this.deps.requesterOf(requester.tenantId, requester.userId);
    if (who === null) throw new SupportRuleError("Unknown user");
    const ticket = await this.raise(
      {
        tenantId: requester.tenantId,
        tenantUserId: requester.userId,
        requesterName: who.name,
        requesterEmail: who.email,
        requesterPhone: who.phone,
        channel: "app",
        subject: input.subject.trim(),
        category: input.category,
        priority: input.priority,
        createdBy: null,
      },
      input.body,
    );
    await this.acknowledge(ticket);
    return this.mine(requester, ticket.id);
  }

  myTickets(requester: Requester, limit: number): Promise<TicketView[]> {
    return this.deps.desk.list({
      tenantId: requester.tenantId,
      ...(requester.seesAll ? {} : { tenantUserId: requester.userId }),
      limit,
    });
  }

  /** A ticket of the user (or of the business), without staff's internal notes. */
  async mine(requester: Requester, id: string): Promise<TicketWithMessages> {
    const ticket = await this.requireMine(requester, id);
    return { ticket, messages: await this.deps.desk.messages(id, false) };
  }

  async customerReply(requester: Requester, id: string, body: string): Promise<TicketWithMessages> {
    const { deps } = this;
    const view = await this.requireMine(requester, id);
    const who = await deps.requesterOf(requester.tenantId, requester.userId);
    await deps.unitOfWork.run(async () => {
      const ticket = await this.lock(id);
      ticket.customerReplied(deps.clock.now());
      await deps.desk.save(ticket);
      await deps.desk.addMessage({
        ticketId: id,
        authorType: "customer",
        authorStaffId: null,
        authorName: who?.name ?? view.requesterName,
        body: body.trim(),
        internal: false,
        cannedResponseId: null,
      });
    });
    return this.mine(requester, id);
  }

  async rate(
    requester: Requester,
    id: string,
    input: Readonly<{ score: number; comment: string | null }>,
  ): Promise<TicketView> {
    const { deps } = this;
    const view = await this.requireMine(requester, id);
    if (view.tenantUserId !== requester.userId)
      throw new SupportRuleError("Only the person who raised the ticket rates it");
    await deps.unitOfWork.run(async () => {
      const ticket = await this.lock(id);
      ticket.rate(input.score, input.comment?.trim() || null, deps.clock.now());
      await deps.desk.save(ticket);
    });
    return this.require(id);
  }

  // --- helpers ---

  private async raise(
    input: Omit<Parameters<typeof SupportTicket.raise>[0], "id" | "number">,
    body: string,
  ): Promise<TicketView> {
    const { deps } = this;
    const now = deps.clock.now();
    const targets = await deps.desk.slaTargets();
    const id = randomUUID();
    await deps.unitOfWork.run(async () => {
      const ticket = SupportTicket.raise(
        { ...input, id, number: await deps.desk.nextNumber(now.getUTCFullYear()) },
        targets,
        now,
      );
      await deps.desk.insert(ticket);
      await deps.desk.addMessage({
        ticketId: id,
        authorType: "customer",
        authorStaffId: null,
        authorName: input.requesterName,
        body: body.trim(),
        internal: false,
        cannedResponseId: null,
      });
    });
    deps.logger.info("Support ticket raised", { ticketId: id, channel: input.channel });
    return this.require(id);
  }

  private async lock(id: string): Promise<SupportTicket> {
    const ticket = await this.deps.desk.lock(id);
    if (ticket === null) throw new SupportTicketNotFoundError();
    return ticket;
  }

  private async require(id: string): Promise<TicketView> {
    const ticket = await this.deps.desk.find(id);
    if (ticket === null) throw new SupportTicketNotFoundError();
    return ticket;
  }

  private async requireMine(requester: Requester, id: string): Promise<TicketView> {
    const ticket = await this.deps.desk.find(id);
    if (
      ticket === null ||
      ticket.tenantId !== requester.tenantId ||
      (!requester.seesAll && ticket.tenantUserId !== requester.userId)
    )
      throw new SupportTicketNotFoundError();
    return ticket;
  }

  private audited(
    actor: PlatformPrincipal,
    action: string,
    ticket: SupportTicket,
    after: Readonly<Record<string, unknown>>,
  ): Promise<string> {
    const t = ticket.snapshot();
    return this.deps.audit.record({
      actorType: "platform_staff",
      actorId: actor.userId,
      action,
      entityType: "support_ticket",
      entityId: t.id,
      targetTenantId: t.tenantId,
      after: { number: t.number, status: t.status, ...after },
    });
  }

  private async acknowledge(ticket: TicketView): Promise<void> {
    if (ticket.requesterEmail === null) return;
    await this.deps.notifications.sendEmail({
      to: ticket.requesterEmail,
      template: "support.ticket_received",
      data: {
        name: ticket.requesterName,
        number: ticket.number,
        subject: ticket.subject,
        answerBy: ticket.firstResponseDueAt.toISOString().slice(0, 16).replace("T", " "),
        url: this.urlOf(ticket),
      },
      idempotencyKey: `support-received:${ticket.id}`,
      tenantId: ticket.tenantId,
    });
  }

  private async emailReply(ticket: TicketView, staffName: string, body: string): Promise<void> {
    if (ticket.requesterEmail === null) return;
    await this.deps.notifications.sendEmail({
      to: ticket.requesterEmail,
      template: "support.ticket_reply",
      data: {
        name: ticket.requesterName,
        number: ticket.number,
        subject: ticket.subject,
        staffName,
        body,
        url: this.urlOf(ticket),
      },
      idempotencyKey: `support-reply:${ticket.id}:${randomUUID()}`,
      tenantId: ticket.tenantId,
    });
  }

  private async emailResolved(ticket: TicketView): Promise<void> {
    if (ticket.requesterEmail === null) return;
    await this.deps.notifications.sendEmail({
      to: ticket.requesterEmail,
      template: "support.ticket_resolved",
      data: {
        name: ticket.requesterName,
        number: ticket.number,
        subject: ticket.subject,
        url: this.urlOf(ticket),
      },
      idempotencyKey: `support-resolved:${ticket.id}:${ticket.resolvedAt?.toISOString() ?? ""}`,
      tenantId: ticket.tenantId,
    });
  }

  private urlOf(ticket: TicketView): string | null {
    return ticket.tenantUserId === null || ticket.tenantSlug === null
      ? null
      : this.deps.ticketUrl(ticket.tenantSlug, ticket.id);
  }
}

function clean(input: CannedResponseInput): CannedResponseInput {
  const title = input.title.trim();
  const body = input.body.trim();
  if (title.length < 3) throw new SupportRuleError("Give the canned response a title");
  if (body === "") throw new SupportRuleError("The canned response is empty");
  return { ...input, title, body };
}

/**
 * Every 15 minutes (decision 500): records SLA breaches once, with an alert for each, resolves
 * tickets left waiting on the customer for a week and closes those resolved for a week.
 */
export class SweepSupportTickets implements IJobHandler<"support.sweep"> {
  readonly job = "support.sweep" as const;

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IPlatformUnitOfWork;
      desk: ISupportDesk;
      alerts: IAlerts;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  async handle(): Promise<void> {
    const { deps } = this;
    const now = deps.clock.now();
    let breaches = 0;
    let quiet = 0;
    for (const id of await deps.desk.sweepCandidates(now, 500)) {
      const outcome = await deps.unitOfWork.run(async () => {
        const ticket = await deps.desk.lock(id);
        if (ticket === null) return null;
        const found = ticket.checkSla(now);
        const done = ticket.housekeeping(now);
        if (found.length === 0 && done === null) return null;
        await deps.desk.save(ticket);
        if (done !== null)
          await deps.desk.addMessage({
            ticketId: id,
            authorType: "system",
            authorStaffId: null,
            authorName: "Autoforce support",
            body:
              done === "resolved"
                ? "Resolved: we did not hear back for a week. Reply to open it again."
                : "Closed a week after it was resolved.",
            internal: false,
            cannedResponseId: null,
          });
        return { ticket: ticket.snapshot(), found };
      });
      if (outcome === null) continue;
      if (outcome.found.length === 0) {
        quiet++;
        continue;
      }
      breaches += outcome.found.length;
      const t = outcome.ticket;
      await deps.alerts.raise({
        key: `support.sla:${t.id}`,
        severity: t.priority === "urgent" || t.priority === "high" ? "critical" : "warning",
        source: "support",
        title: `${t.number} is past its ${outcome.found.includes("resolution") ? "resolution" : "first response"} target`,
        detail: {
          ticketId: t.id,
          number: t.number,
          priority: t.priority,
          breaches: outcome.found,
          assigneeId: t.assigneeId,
        },
        tenantId: t.tenantId,
        runbook: "docs/35 support",
      });
    }
    if (breaches + quiet > 0) deps.logger.info("Support sweep", { breaches, quiet });
  }
}
