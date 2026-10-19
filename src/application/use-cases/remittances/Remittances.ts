import type { PaymentMethod } from "../../../domain/finance/Payment.js";
import { Postings } from "../../../domain/finance/Postings.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import {
  Remittance,
  RemittanceRuleError,
  type RemittanceProps,
} from "../../../domain/remittances/Remittance.js";
import type { IRemittanceRepository } from "../../../domain/repositories/IRemittanceRepository.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import type { Page } from "../../dto/Page.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAssignmentQueries } from "../../ports/IAssignmentRecords.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type {
  IRemittanceRecords,
  IRemittanceSettingsStore,
  RemittanceListFilter,
  RemittancePayment,
  RemittanceSubmission,
} from "../../ports/IRemittanceRecords.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import { PageCursor } from "../../services/PageCursor.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { PaymentRecording } from "../finance/PaymentRecording.js";
import type { DocumentNumbering } from "../reference/DocumentNumbering.js";
import { recordUserAction } from "../reference/userAudit.js";

export class RemittanceNotFoundError extends ApplicationError {
  readonly code = "REMITTANCE_NOT_FOUND";
  constructor(message = "Remittance not found") {
    super(message);
  }
}

export type Declaration = Readonly<{
  amount: string;
  method: PaymentMethod;
  momoNetwork?: "mtn" | "telecel" | "at" | null;
  reference?: string | null;
  earnings?: Readonly<Record<string, number>> | null;
  notes?: string | null;
}>;

export type MoneyReceived = Readonly<{
  amount: string;
  method: PaymentMethod;
  momoNetwork?: "mtn" | "telecel" | "at" | null;
  reference?: string | null;
}>;

export type RemittanceView = Omit<
  RemittanceProps,
  "expectedMinor" | "receivedMinor" | "waivedMinor" | "accruedMinor"
> &
  Readonly<{
    expected: MoneyJson | null;
    received: MoneyJson;
    waived: MoneyJson;
    outstanding: MoneyJson;
    submissions?: readonly (Omit<RemittanceSubmission, "declaredMinor"> &
      Readonly<{ declared: MoneyJson }>)[];
    payments?: readonly (Omit<RemittancePayment, "amountMinor" | "settledMinor"> &
      Readonly<{ amount: MoneyJson; settled: MoneyJson }>)[];
  }>;

export type RemittanceQuery = Omit<RemittanceListFilter, "branchIds" | "after" | "limit"> &
  Readonly<{ limit: number; cursor?: string }>;

/**
 * Remittances (docs/09 §2): expected rows come from the daily job for fixed targets; a variable
 * period is declared when the driver pays. Declarations wait for a supervisor, who confirms the
 * money (a payment through finance, settling what the driver owes) or rejects it; staff who take
 * the money themselves record it directly. A shortfall stays on the driver's ledger unless
 * waived.
 */
export class Remittances {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      remittances: IRemittanceRepository;
      records: IRemittanceRecords;
      settings: IRemittanceSettingsStore;
      assignments: IAssignmentQueries;
      payments: PaymentRecording;
      posting: LedgerPosting;
      scope: BranchScope;
      numbering: DocumentNumbering;
      calendar: TenantCalendar;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  async list(actor: Principal, query: RemittanceQuery): Promise<Page<RemittanceView>> {
    const { deps } = this;
    const after = query.cursor === undefined ? undefined : PageCursor.parse(query.cursor, 2).values;
    return deps.unitOfWork.run(async () => {
      const rows = await deps.records.list({
        ...query,
        branchIds: deps.scope.branchesFor(actor, "remittances.list"),
        limit: query.limit + 1,
        ...(after === undefined
          ? {}
          : { after: { periodStart: String(after[0]), id: String(after[1]) } }),
      });
      const base = await deps.posting.baseCurrency();
      const page = PageCursor.paginate(rows, query.limit, (r) => [r.periodStart, r.id]);
      return { ...page, items: page.items.map((r) => remittanceView(r, base)) };
    });
  }

  async get(actor: Principal, id: string): Promise<RemittanceView> {
    return this.deps.unitOfWork.run(async () =>
      this.detail(await this.reach(actor, id, "remittances.view")),
    );
  }

  /** A variable-mode period declared by (or for) the driver of a vehicle. */
  async declarePeriod(
    actor: Principal,
    input: Readonly<{ vehicleId: string; periodStart: string; periodEnd: string } & Declaration>,
  ): Promise<RemittanceView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const assignment = await deps.assignments.at(
        input.vehicleId,
        new Date(`${input.periodEnd}T12:00:00Z`),
      );
      if (assignment === null || assignment.terms.mode !== "variable")
        throw new RemittanceRuleError(
          "No driver on variable remittance had this vehicle in that period",
        );
      await deps.scope.branch(actor, "remittances.submit", assignment.branchId);
      const remittance = Remittance.variable({
        id: deps.ids.next(),
        assignmentId: assignment.id,
        driverId: assignment.driverId,
        vehicleId: assignment.vehicleId,
        branchId: assignment.branchId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        now: deps.clock.now(),
      });
      await deps.remittances.save(remittance);
      await this.addSubmission(actor, remittance, input);
      return this.detail(remittance);
    });
  }

  /** Declares what was paid for a period (waits for a supervisor). */
  async submit(actor: Principal, id: string, declaration: Declaration): Promise<RemittanceView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const remittance = await this.reach(actor, id, "remittances.submit", true);
      if ((await deps.records.lockOpenSubmission(id)) !== null)
        throw new RemittanceRuleError(
          "A declaration for this period is already waiting for approval",
        );
      await this.addSubmission(actor, remittance, declaration);
      return this.detail(remittance);
    });
  }

  /**
   * Confirms a declaration (or, without one, money the supervisor states): the payment is
   * recorded in finance and settles the period.
   */
  async approve(
    actor: Principal,
    id: string,
    input: Readonly<{ submissionId: string; amount?: string }>,
  ): Promise<RemittanceView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const remittance = await this.reach(actor, id, "remittances.approve", true);
      const submission = await deps.records.lockOpenSubmission(id);
      if (submission?.id !== input.submissionId)
        throw new RemittanceNotFoundError("That declaration is not waiting for approval");
      const base = await deps.posting.baseCurrency();
      const amount =
        input.amount ?? Money.ofMinor(submission.declaredMinor, base).toDecimalString();
      const paymentId = await this.confirm(actor, remittance, {
        amount,
        method: submission.method,
        momoNetwork: submission.momoNetwork,
        reference: submission.reference,
      });
      await deps.records.saveSubmission({
        ...submission,
        status: "approved",
        decidedBy: actor.userId,
        decidedAt: deps.clock.now(),
        paymentId,
      });
      await this.refresh(remittance);
      await this.audit(actor, "remittance.approved", remittance, {
        submissionId: submission.id,
        paymentId,
      });
      return this.detail(remittance);
    });
  }

  /** Money taken by staff directly (no declaration to confirm). */
  async record(actor: Principal, id: string, money: MoneyReceived): Promise<RemittanceView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const remittance = await this.reach(actor, id, "remittances.record", true);
      if ((await deps.records.lockOpenSubmission(id)) !== null)
        throw new RemittanceRuleError("A declaration is waiting: approve or reject it instead");
      const paymentId = await this.confirm(actor, remittance, money);
      await this.refresh(remittance);
      await this.audit(actor, "remittance.recorded", remittance, { paymentId });
      return this.detail(remittance);
    });
  }

  async reject(
    actor: Principal,
    id: string,
    submissionId: string,
    reason: string,
  ): Promise<RemittanceView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const remittance = await this.reach(actor, id, "remittances.approve", true);
      const submission = await deps.records.lockOpenSubmission(id);
      if (submission?.id !== submissionId)
        throw new RemittanceNotFoundError("That declaration is not waiting for approval");
      if (reason.trim().length < 3) throw new RemittanceRuleError("Give a reason for rejecting it");
      await deps.records.saveSubmission({
        ...submission,
        status: "rejected",
        decidedBy: actor.userId,
        decidedAt: deps.clock.now(),
        rejectReason: reason.trim(),
      });
      await this.refresh(remittance);
      await this.audit(actor, "remittance.rejected", remittance, { submissionId, reason });
      return this.detail(remittance);
    });
  }

  async waive(
    actor: Principal,
    id: string,
    input: Readonly<{ amount?: string; reason: string }>,
  ): Promise<RemittanceView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const remittance = await this.reach(actor, id, "remittances.waive", true);
      const base = await deps.posting.baseCurrency();
      const accounts = await deps.posting.accounts();
      const today = await deps.calendar.today();
      const now = deps.clock.now();
      const accrued = remittance.accrueTarget(now);
      if (accrued > 0)
        await deps.posting.post(
          Postings.remittanceAccrued(remittance, accrued, accounts, today),
          actor.userId,
        );
      const waived = remittance.waive(
        input.amount === undefined ? null : Money.parse(input.amount, base).amountMinor,
        input.reason,
        now,
      );
      await deps.posting.post(
        Postings.remittanceWaived(remittance, waived, accounts, today),
        actor.userId,
      );
      await this.refresh(remittance);
      await this.audit(actor, "remittance.waived", remittance, {
        waivedMinor: waived,
        reason: input.reason,
      });
      return this.detail(remittance);
    });
  }

  /** Records the payment (finance), accrues a target that was not yet due, settles. */
  private async confirm(
    actor: Principal,
    remittance: Remittance,
    money: MoneyReceived,
  ): Promise<string> {
    const { deps } = this;
    const r = remittance.snapshot();
    const base = await deps.posting.baseCurrency();
    const amountMinor = Money.parse(money.amount, base).amountMinor;
    const payment = await deps.payments.record(actor, {
      direction: "in",
      method: money.method,
      partyType: "driver",
      partyId: r.driverId,
      branchId: r.branchId,
      vehicleId: r.vehicleId,
      amount: money.amount,
      reference: money.reference ?? null,
      momoNetwork: money.momoNetwork ?? null,
      notes: `Remittance ${r.periodStart}${r.periodEnd === r.periodStart ? "" : ` – ${r.periodEnd}`}`,
      source: { type: "remittance", id: r.id },
    });
    const now = deps.clock.now();
    const today = await deps.calendar.today();
    const accounts = await deps.posting.accounts();
    remittance.numbered(
      await deps.numbering.next("remittance", new Date(`${r.periodStart}T12:00:00Z`)),
    );
    const accrued = remittance.accrueTarget(now);
    if (accrued > 0)
      await deps.posting.post(
        Postings.remittanceAccrued(remittance, accrued, accounts, today),
        actor.userId,
      );
    const { settled, income } = remittance.receive(amountMinor, now);
    const entry = Postings.remittanceSettled(
      remittance,
      { paymentId: payment.id, settled, income, date: today },
      accounts,
    );
    if (entry !== null) await deps.posting.post(entry, actor.userId);
    await deps.records.savePayment({
      id: deps.ids.next(),
      remittanceId: r.id,
      paymentId: payment.id,
      amountMinor,
      settledMinor: settled,
      releasedAt: null,
      createdAt: now,
    });
    await deps.remittances.save(remittance);
    return payment.id;
  }

  private async addSubmission(
    actor: Principal,
    remittance: Remittance,
    d: Declaration,
  ): Promise<void> {
    const { deps } = this;
    const base = await deps.posting.baseCurrency();
    const declaredMinor = Money.parse(d.amount, base).amountMinor;
    if (declaredMinor <= 0) throw new RemittanceRuleError("Declare an amount above zero");
    if (d.method === "momo" && (d.momoNetwork ?? null) === null)
      throw new RemittanceRuleError("A mobile money payment needs its network");
    const text = (value: string | null | undefined, max: number) => {
      const trimmed = value?.trim() ?? "";
      return trimmed === "" ? null : trimmed.slice(0, max);
    };
    await deps.records.saveSubmission({
      id: deps.ids.next(),
      remittanceId: remittance.id,
      declaredMinor,
      method: d.method,
      momoNetwork: d.momoNetwork ?? null,
      reference: text(d.reference, 100),
      earnings: d.earnings ?? null,
      notes: text(d.notes, 2_000),
      status: "submitted",
      submittedBy: actor.userId,
      submittedAt: deps.clock.now(),
      decidedBy: null,
      decidedAt: null,
      rejectReason: null,
      paymentId: null,
    });
    await this.refresh(remittance);
    await this.audit(actor, "remittance.submitted", remittance, {
      declaredMinor,
      method: d.method,
    });
  }

  /** Recomputes and saves the status (call inside the unit of work). */
  async refresh(remittance: Remittance): Promise<void> {
    const { deps } = this;
    const { graceDays } = await deps.settings.get();
    const open = (await deps.records.lockOpenSubmission(remittance.id)) !== null;
    remittance.refresh(await deps.calendar.today(), graceDays, open, deps.clock.now());
    await deps.remittances.save(remittance);
  }

  private async reach(
    actor: Principal,
    id: string,
    permission: PermissionKey,
    lock = false,
  ): Promise<Remittance> {
    const { deps } = this;
    const remittance = lock
      ? await deps.remittances.lockById(id)
      : await deps.remittances.findById(id);
    if (remittance === null) throw new RemittanceNotFoundError();
    await deps.scope.assertReaches(
      actor,
      permission,
      remittance.snapshot().branchId,
      () => new RemittanceNotFoundError(),
    );
    return remittance;
  }

  private async detail(remittance: Remittance): Promise<RemittanceView> {
    const { deps } = this;
    const base = await deps.posting.baseCurrency();
    const m = (minor: number) => Money.ofMinor(minor, base).toJSON();
    return {
      ...remittanceView(remittance.snapshot(), base),
      submissions: (await deps.records.submissions(remittance.id)).map(
        ({ declaredMinor, ...s }) => ({
          ...s,
          declared: m(declaredMinor),
        }),
      ),
      payments: (await deps.records.payments(remittance.id)).map(
        ({ amountMinor, settledMinor, ...p }) => ({
          ...p,
          amount: m(amountMinor),
          settled: m(settledMinor),
        }),
      ),
    };
  }

  private async audit(
    actor: Principal,
    action: string,
    remittance: Remittance,
    metadata: Readonly<Record<string, unknown>>,
  ) {
    const r = remittance.snapshot();
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: "remittance",
      entityId: r.id,
      after: {
        driverId: r.driverId,
        vehicleId: r.vehicleId,
        period: [r.periodStart, r.periodEnd],
        status: r.status,
        receivedMinor: r.receivedMinor,
      },
      metadata,
    });
  }
}

export function remittanceView(r: RemittanceProps, currency: string): RemittanceView {
  const m = (minor: number) => Money.ofMinor(minor, currency).toJSON();
  const { expectedMinor, receivedMinor, waivedMinor, accruedMinor: _accrued, ...rest } = r;
  return {
    ...rest,
    expected: expectedMinor === null ? null : m(expectedMinor),
    received: m(receivedMinor),
    waived: m(waivedMinor),
    outstanding: m(Remittance.restore(r).outstandingMinor),
  };
}
