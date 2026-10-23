import { checkExtension, deactivationDate } from "../../../domain/billing/Dunning.js";
import type { IBillingRepository } from "../../../domain/repositories/IBillingRepository.js";
import type {
  ExtensionRecord,
  ExtensionStatus,
  IBillingAutomationRepository,
} from "../../../domain/repositories/IBillingAutomationRepository.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import { recordStaffAction } from "../console/consoleAudit.js";
import type { TenantLifecycleService } from "../tenants/TenantLifecycleService.js";
import type { BillingNotices } from "./BillingNotices.js";
import { InvoiceNotFoundError } from "./ManualBilling.js";

export class ExtensionNotFoundError extends ApplicationError {
  readonly code = "EXTENSION_NOT_FOUND";
  constructor() {
    super("Extension request not found");
  }
}

/** The request cannot be made or decided as asked (409). */
export class ExtensionStateError extends ApplicationError {
  constructor(
    readonly code: "EXTENSION_OPEN" | "EXTENSION_DECIDED" | "EXTENSION_LIMIT",
    message: string,
  ) {
    super(message);
  }
}

const DAY_MS = 86_400_000;
const SUPER_ADMIN = "super_admin";

/**
 * More time to pay (docs/25 §5.4): the tenant asks from the Billing tab (also in billing-only
 * mode) for a date at most 10 days after the due date; staff with
 * `platform.billing.extensions.grant` approve (possibly a different date) or deny. Over the
 * rolling 90-day limit only a Super Admin may approve. An approved extension moves the
 * automation's deadline for that invoice and restores a tenant deactivated by billing at once
 * (unless staff locked it); a payment closes it. Every request and decision is audited and the
 * tenant is told.
 */
export class BillingExtensions {
  constructor(
    private readonly deps: Readonly<{
      automation: IBillingAutomationRepository;
      billing: IBillingRepository;
      lifecycle: TenantLifecycleService;
      notices: BillingNotices;
      unitOfWork: IPlatformUnitOfWork;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  async request(
    tenantId: string,
    input: Readonly<{ invoiceId: string; requestedUntil: string; note?: string | null }>,
    userId: string,
  ): Promise<ExtensionRecord> {
    const { deps } = this;
    const today = this.today();
    const { policy } = await deps.automation.policy();
    return deps.unitOfWork.run(async () => {
      const invoice = await deps.billing.invoice(input.invoiceId, true);
      const i = invoice?.snapshot();
      if (i === undefined || i.tenantId !== tenantId || i.status !== "open")
        throw new InvoiceNotFoundError();
      const open = await deps.automation.extensions({ tenantId, limit: 50 });
      if (
        open.some(
          (e) => e.invoiceId === i.id && (e.status === "requested" || e.status === "approved"),
        )
      )
        throw new ExtensionStateError(
          "EXTENSION_OPEN",
          "This invoice already has an extension request or an extension",
        );
      checkExtension({
        dueOn: i.dueAt.toISOString().slice(0, 10),
        until: input.requestedUntil,
        today,
        policy,
        approvedInLast90Days: 0,
      });
      const extension: ExtensionRecord = {
        id: deps.ids.next(),
        tenantId,
        invoiceId: i.id,
        requestedUntil: input.requestedUntil,
        note: input.note?.trim() || null,
        status: "requested",
        approvedUntil: null,
        requestedBy: userId,
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        createdAt: deps.clock.now(),
      };
      await deps.automation.addExtension(extension);
      await deps.billing.appendEvent(i.subscriptionId, {
        type: "extension_requested",
        details: { extensionId: extension.id, invoiceId: i.id, until: input.requestedUntil },
        actorType: "user",
        actorId: userId,
      });
      return extension;
    });
  }

  list(
    filter: Readonly<{ tenantId?: string; status?: ExtensionStatus; limit: number }>,
  ): Promise<ExtensionRecord[]> {
    return this.deps.automation.extensions(filter);
  }

  async approve(
    id: string,
    input: Readonly<{ until?: string; reason: string }>,
    actor: PlatformPrincipal,
  ): Promise<ExtensionRecord> {
    const { deps } = this;
    const today = this.today();
    const { policy } = await deps.automation.policy();
    const decided = await deps.unitOfWork.run(async () => {
      const extension = await this.requested(id);
      const invoice = (await deps.billing.invoice(extension.invoiceId))!.snapshot();
      const until = input.until ?? extension.requestedUntil;
      const { overLimit } = checkExtension({
        dueOn: invoice.dueAt.toISOString().slice(0, 10),
        until,
        today,
        policy,
        approvedInLast90Days: await deps.automation.approvedSince(
          extension.tenantId,
          new Date(deps.clock.now().getTime() - 90 * DAY_MS),
        ),
      });
      if (overLimit && !actor.systemRoles.has(SUPER_ADMIN))
        throw new ExtensionStateError(
          "EXTENSION_LIMIT",
          `The tenant had ${policy.extension.maxPer90Days} extensions in 90 days; only a Super Admin can approve another`,
        );
      const approved: ExtensionRecord = {
        ...extension,
        status: "approved",
        approvedUntil: until,
        decidedBy: actor.userId,
        decidedAt: deps.clock.now(),
        decisionReason: input.reason.trim(),
      };
      await deps.automation.saveExtension(approved);
      await deps.billing.appendEvent(invoice.subscriptionId, {
        type: "extension_approved",
        details: { extensionId: id, invoiceId: invoice.id, until, overLimit },
        actorType: "platform_staff",
        actorId: actor.userId,
      });
      await recordStaffAction(deps, actor, {
        action: "billing.extension_approved",
        entityType: "billing_extension",
        entityId: id,
        targetTenantId: extension.tenantId,
        after: { until, overLimit },
        reason: input.reason.trim(),
      });
      return { approved, invoice };
    });
    await deps.lifecycle.liftForExtension(decided.approved.tenantId, actor);
    await this.tell("extension_approved", decided.approved, decided.invoice, policy);
    return decided.approved;
  }

  async deny(id: string, reason: string, actor: PlatformPrincipal): Promise<ExtensionRecord> {
    const { deps } = this;
    const { policy } = await deps.automation.policy();
    const decided = await deps.unitOfWork.run(async () => {
      const extension = await this.requested(id);
      const invoice = (await deps.billing.invoice(extension.invoiceId))!.snapshot();
      const denied: ExtensionRecord = {
        ...extension,
        status: "denied",
        decidedBy: actor.userId,
        decidedAt: deps.clock.now(),
        decisionReason: reason.trim(),
      };
      await deps.automation.saveExtension(denied);
      await recordStaffAction(deps, actor, {
        action: "billing.extension_denied",
        entityType: "billing_extension",
        entityId: id,
        targetTenantId: extension.tenantId,
        reason: reason.trim(),
      });
      return { denied, invoice };
    });
    await this.tell("extension_denied", decided.denied, decided.invoice, policy);
    return decided.denied;
  }

  private async requested(id: string): Promise<ExtensionRecord> {
    const extension = await this.deps.automation.extension(id, true);
    if (extension === null) throw new ExtensionNotFoundError();
    if (extension.status !== "requested")
      throw new ExtensionStateError("EXTENSION_DECIDED", "This request was already decided");
    return extension;
  }

  private async tell(
    step: "extension_approved" | "extension_denied",
    e: ExtensionRecord,
    invoice: Readonly<{
      id: string;
      dueAt: Date;
      totalMinor: number;
      paidMinor: number;
      currency: string;
      lines: readonly Readonly<{ kind: string; quantity: number }>[];
    }>,
    policy: Awaited<ReturnType<IBillingAutomationRepository["policy"]>>["policy"],
  ): Promise<void> {
    const { deps } = this;
    try {
      const dueOn = invoice.dueAt.toISOString().slice(0, 10);
      await deps.notices.send(
        step,
        {
          tenantId: e.tenantId,
          tenantName: await deps.billing.tenantName(e.tenantId),
          invoiceId: invoice.id,
          outstandingMinor: invoice.totalMinor - invoice.paidMinor,
          currency: invoice.currency,
          branchCount: invoice.lines.find((l) => l.kind === "branch_rate")?.quantity ?? 1,
          dueOn,
          deactivateOn: deactivationDate(dueOn, policy, e.approvedUntil),
          extendedUntil: e.approvedUntil,
        },
        policy.channels,
      );
    } catch (error) {
      deps.logger.warn("Could not tell the tenant about an extension decision", {
        extensionId: e.id,
        error,
      });
    }
  }

  private today(): string {
    return this.deps.clock.now().toISOString().slice(0, 10);
  }
}
