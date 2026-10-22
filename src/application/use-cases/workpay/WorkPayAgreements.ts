import { Postings } from "../../../domain/finance/Postings.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { PenaltyRule } from "../../../domain/workpay/WorkPayCollections.js";
import {
  LIVE_STATUSES,
  pricingOf,
  WorkPayAgreement,
  type AgreementStatus,
  type Guarantor,
  type Responsibility,
  type WorkPayAgreementProps,
} from "../../../domain/workpay/WorkPayAgreement.js";
import {
  workPayTerms,
  WorkPayRuleError,
  type Pricing,
  type WorkPayFrequency,
  type WorkPayTerms,
} from "../../../domain/workpay/WorkPayTerms.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import type { Page } from "../../dto/Page.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IDocumentRepository } from "../../ports/IDocumentRecords.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type {
  InstalmentRecord,
  IWorkPayAgreementRepository,
  IWorkPaySchedule,
  IWorkPaySettingsStore,
} from "../../ports/IWorkPayRecords.js";
import type { BranchScope } from "../../services/BranchScope.js";
import { PageCursor } from "../../services/PageCursor.js";
import { TenantCalendar } from "../../services/TenantCalendar.js";
import type { ChecklistAnswers } from "../../../domain/assignments/VehicleAssignment.js";
import type { VehicleAssignments } from "../assignments/VehicleAssignments.js";
import type { Documents } from "../documents/Documents.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { PaymentRecording } from "../finance/PaymentRecording.js";
import type { DriverAdministration } from "../parties/DriverAdministration.js";
import type { DocumentNumbering } from "../reference/DocumentNumbering.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { VehicleAccess } from "../vehicles/VehicleAccess.js";

export class AgreementNotFoundError extends ApplicationError {
  readonly code = "WORKPAY_AGREEMENT_NOT_FOUND";
  constructor() {
    super("Agreement not found");
  }
}

/** Terms as the API takes them: amounts as text in the base currency. */
export type TermsRequest = Readonly<{
  /** Default: the vehicle's book value today. */
  vehicleValue?: string;
  pricing:
    | Readonly<{ kind: "multiplier"; multiplier: string }>
    | Readonly<{ kind: "markup_percent"; percent: string }>
    | Readonly<{ kind: "total"; total: string }>;
  deposit?: string;
  frequency?: WorkPayFrequency;
  periods?: number;
  months?: number;
  /** Default: today plus the settings' days. */
  firstDueOn?: string;
  daysOff?: readonly number[];
  /** Instalments as a multiple of this amount ("1.00": whole cedis). */
  roundTo?: string;
}>;

/** The late-payment rule as the API takes it: amounts as text in the base currency. */
export type PenaltyRequest =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "flat"; amount: string }>
  | Readonly<{ kind: "percent"; percent: string }>
  | Readonly<{ kind: "daily"; amount: string; cap?: string | null }>;

export type AgreementRequest = Readonly<{
  vehicleId: string;
  driverId: string;
  terms: TermsRequest;
  graceDays?: number;
  /** Default: the settings' rule. */
  penalty?: PenaltyRequest;
  maintenance?: Responsibility;
  insurance?: Responsibility;
  guarantors?: readonly Guarantor[];
  notes?: string | null;
}>;

export type InstalmentView = Readonly<{
  number: number;
  dueOn: string;
  amount: MoneyJson;
  paid?: MoneyJson;
  status?: InstalmentRecord["status"];
}>;

export type TermsView = Readonly<{
  vehicleValue: MoneyJson;
  pricing: Pricing;
  totalPrice: MoneyJson;
  markup: MoneyJson;
  deposit: MoneyJson;
  financed: MoneyJson;
  frequency: WorkPayFrequency;
  periods: number;
  instalment: MoneyJson;
  lastInstalment: MoneyJson;
  firstDueOn: string;
  lastDueOn: string;
  daysOff: readonly number[];
}>;

export type AgreementView = Omit<WorkPayAgreementProps, "terms" | "depositPaidMinor"> &
  Readonly<{
    terms: TermsView;
    /** The penalty rule in words. */
    lateFee: string;
    depositPaid: MoneyJson;
    depositOutstanding: MoneyJson;
    document: Readonly<{ id: string; number: string; status: string }> | null;
    schedule?: readonly InstalmentView[];
  }>;

const RESPONSIBLE: Readonly<Record<Responsibility, string>> = {
  driver: "the driver",
  owner: "the owner",
  shared: "the driver and the owner together",
};
const EVERY: Readonly<Record<WorkPayFrequency, string>> = {
  daily: "every working day",
  weekly: "every week",
  monthly: "every month",
};

const show = (j: MoneyJson) => j.formatted;

/** The late-payment rule in the words the agreement uses. */
export function lateFee(rule: PenaltyRule, m: (minor: number) => MoneyJson): string {
  switch (rule.kind) {
    case "none":
      return "No late fee is charged";
    case "flat":
      return `A late fee of ${show(m(rule.amountMinor))} is charged once on each overdue instalment`;
    case "percent":
      return `A late fee of ${rule.percent}% of the overdue amount is charged once on each overdue instalment`;
    case "daily":
      return `A late fee of ${show(m(rule.amountMinor))} is charged for every day an instalment is overdue${
        rule.capMinor === null ? "" : `, up to ${show(m(rule.capMinor))} per instalment`
      }`;
  }
}

/**
 * Work & Pay agreements (docs/08 §2–3, §5): simulate terms, draft an agreement with its
 * guarantors, send the agreement document out for signature (owner, driver, guarantors who
 * sign), take the deposit, and start it once signed — the instalment schedule is created, the
 * driver gets the vehicle (a `workpay` assignment, vehicle on work and pay). The price is fixed
 * by the signed document: changing anything means withdrawing it and signing again.
 */
export class WorkPayAgreements {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      agreements: IWorkPayAgreementRepository;
      schedule: IWorkPaySchedule;
      settings: IWorkPaySettingsStore;
      documents: Documents;
      documentRecords: IDocumentRepository;
      payments: PaymentRecording;
      assignments: VehicleAssignments;
      vehicles: VehicleAccess;
      drivers: DriverAdministration;
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

  /** What terms would give, without saving anything (the simulator). */
  async simulate(
    actor: Principal,
    request: Readonly<{ vehicleId?: string; terms: TermsRequest }>,
  ): Promise<TermsView & Readonly<{ schedule: readonly InstalmentView[] }>> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const vehicle =
        request.vehicleId === undefined
          ? null
          : await deps.vehicles.reach(actor, request.vehicleId, "workpay.view");
      const terms = await this.terms(request.terms, vehicle);
      const m = await this.money();
      return {
        ...this.termsView(terms, m),
        schedule: terms.schedule.map((i) => ({
          number: i.number,
          dueOn: i.dueOn,
          amount: m(i.amountMinor),
        })),
      };
    });
  }

  async create(actor: Principal, request: AgreementRequest): Promise<AgreementView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const vehicle = await deps.vehicles.reach(actor, request.vehicleId, "workpay.create");
      const driver = (
        await deps.drivers.reach(actor, request.driverId, "workpay.create")
      ).snapshot();
      if (driver.status !== "active")
        throw new WorkPayRuleError("Only an active driver can take a work and pay agreement");
      if (driver.branchId !== vehicle.branchId)
        throw new WorkPayRuleError("The driver and the vehicle must be in the same branch");
      await this.assertFree(request.vehicleId, request.driverId);
      const settings = await deps.settings.get();
      const now = deps.clock.now();
      const agreement = WorkPayAgreement.draft({
        id: deps.ids.next(),
        number: await deps.numbering.next("workpay_agreement", now),
        vehicleId: vehicle.id,
        driverId: driver.id,
        branchId: vehicle.branchId,
        terms: await this.terms(request.terms, vehicle),
        graceDays: request.graceDays ?? settings.defaultGraceDays,
        penalty:
          request.penalty === undefined
            ? settings.defaultPenalty
            : await this.penaltyRule(request.penalty),
        maintenance: request.maintenance ?? settings.defaultMaintenance,
        insurance: request.insurance ?? settings.defaultInsurance,
        guarantors: request.guarantors ?? [],
        notes: request.notes ?? null,
        createdBy: actor.userId,
        now,
      });
      await deps.agreements.save(agreement);
      await this.audit(actor, "workpay.agreement_drafted", agreement);
      return this.view(agreement, true);
    });
  }

  async revise(
    actor: Principal,
    id: string,
    changes: Omit<Partial<AgreementRequest>, "vehicleId" | "driverId">,
  ): Promise<AgreementView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await this.reach(actor, id, "workpay.create", true);
      const vehicle = await deps.vehicles.reach(
        actor,
        agreement.snapshot().vehicleId,
        "workpay.create",
      );
      agreement.revise(
        {
          ...(changes.terms === undefined
            ? {}
            : { terms: await this.terms(changes.terms, vehicle) }),
          ...(changes.graceDays === undefined ? {} : { graceDays: changes.graceDays }),
          ...(changes.penalty === undefined
            ? {}
            : { penalty: await this.penaltyRule(changes.penalty) }),
          ...(changes.maintenance === undefined ? {} : { maintenance: changes.maintenance }),
          ...(changes.insurance === undefined ? {} : { insurance: changes.insurance }),
          ...(changes.guarantors === undefined ? {} : { guarantors: changes.guarantors }),
          ...(changes.notes === undefined ? {} : { notes: changes.notes }),
        },
        deps.clock.now(),
      );
      await deps.agreements.save(agreement);
      await this.audit(actor, "workpay.agreement_revised", agreement);
      return this.view(agreement, true);
    });
  }

  /**
   * Issues the agreement document for the owner (`businessSignerId`, default the caller), the
   * driver and every guarantor who signs; the terms freeze until it is withdrawn.
   */
  async sendForSignature(
    actor: Principal,
    id: string,
    options: Readonly<{ businessSignerId?: string | null }> = {},
  ): Promise<AgreementView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await this.reach(actor, id, "workpay.create", true);
      const a = agreement.snapshot();
      await this.assertFree(a.vehicleId, a.driverId, a.id);
      const vehicle = (await deps.vehicles.reach(actor, a.vehicleId, "workpay.create")).snapshot();
      const driver = (await deps.drivers.reach(actor, a.driverId, "workpay.create")).snapshot();
      const m = await this.money();
      const terms = this.schedule(a);
      const document = await deps.documents.issue(actor.userId, {
        type: "workpay_agreement",
        subject: { type: "workpay_agreement", id: a.id },
        branchId: a.branchId,
        data: {
          vehicle: {
            code: vehicle.code,
            plateNumber: vehicle.plateNumber,
            make: vehicle.make,
            model: vehicle.model,
            year: vehicle.year,
            colour: vehicle.colour,
            vin: vehicle.vin ?? vehicle.chassisNumber,
            engineNumber: vehicle.engineNumber,
          },
          driver: {
            code: driver.code,
            name: `${driver.firstName} ${driver.lastName}`,
            phone: driver.phone,
            address: driver.address,
            ghanaCardNumber: driver.ghanaCardNumber,
            licenceNumber: driver.licenceNumber,
          },
          agreement: {
            number: a.number,
            startDate: a.terms.firstDueOn,
            price: m(a.terms.totalPriceMinor),
            deposit: m(a.terms.depositMinor),
            financed: m(a.terms.financedMinor),
            instalment: m(a.terms.instalmentMinor),
            instalments: a.terms.periods,
            frequency: EVERY[a.terms.frequency],
            firstDueOn: a.terms.firstDueOn,
            lastDueOn: a.terms.lastDueOn,
            graceDays: a.graceDays,
            lateFee: lateFee(a.penalty, m),
            maintenance: RESPONSIBLE[a.maintenance],
            insurance: RESPONSIBLE[a.insurance],
          },
          schedule: terms.schedule.map((i) => ({
            number: i.number,
            dueOn: i.dueOn,
            amount: m(i.amountMinor),
          })),
          guarantors: a.guarantors.map((g) => ({
            name: g.name,
            phone: g.phone,
            relationship: g.relationship,
          })),
        },
        signers: [
          { role: "owner", party: { type: "user", id: options.businessSignerId ?? actor.userId } },
          { role: "driver", party: { type: "driver", id: a.driverId } },
          ...a.guarantors.flatMap((g, i) =>
            g.signs
              ? [
                  {
                    role: `guarantor_${i + 1}`,
                    party: { type: "guest" as const, name: g.name, phone: g.phone },
                  },
                ]
              : [],
          ),
        ],
      });
      agreement.sentForSignature(document.id, deps.clock.now());
      await deps.agreements.save(agreement);
      await this.audit(actor, "workpay.agreement_sent_for_signature", agreement);
      return this.view(agreement, false);
    });
  }

  /** Back to draft to change something: the document out for signature is voided. */
  async withdraw(actor: Principal, id: string, reason: string): Promise<AgreementView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await this.reach(actor, id, "workpay.create", true);
      const documentId = agreement.withdraw(deps.clock.now());
      await this.voidDocument(actor, documentId, `Agreement withdrawn: ${reason}`);
      await deps.agreements.save(agreement);
      await this.audit(actor, "workpay.agreement_withdrawn", agreement, { reason });
      return this.view(agreement, true);
    });
  }

  /** The deposit (or part of it): a payment from the driver through finance. */
  async recordDeposit(
    actor: Principal,
    id: string,
    money: Readonly<{
      amount: string;
      method: "cash" | "momo" | "bank_transfer" | "cheque" | "card";
      momoNetwork?: "mtn" | "telecel" | "at" | null;
      reference?: string | null;
    }>,
  ): Promise<AgreementView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await this.reach(actor, id, "workpay.payment.record", true);
      const a = agreement.snapshot();
      const base = await deps.posting.baseCurrency();
      const amountMinor = Money.parse(money.amount, base).amountMinor;
      if (amountMinor <= 0) throw new WorkPayRuleError("The deposit paid must be above zero");
      agreement.depositReceived(amountMinor, deps.clock.now());
      await deps.payments.record(actor, {
        direction: "in",
        method: money.method,
        partyType: "driver",
        partyId: a.driverId,
        branchId: a.branchId,
        vehicleId: a.vehicleId,
        amount: money.amount,
        reference: money.reference ?? null,
        momoNetwork: money.momoNetwork ?? null,
        notes: `Deposit, work and pay agreement ${a.number}`,
        source: { type: "workpay_deposit", id: a.id },
      });
      await deps.agreements.save(agreement);
      await this.audit(actor, "workpay.deposit_recorded", agreement, { amountMinor });
      return this.view(agreement, false);
    });
  }

  /**
   * Starts a signed agreement: the schedule is created and the vehicle handed over (odometer and
   * checklist), on or before the first due date.
   */
  async activate(
    actor: Principal,
    id: string,
    handover: Readonly<{ odometer: number; checklist: ChecklistAnswers; notes?: string | null }>,
  ): Promise<AgreementView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await this.reach(actor, id, "workpay.activate", true);
      const a = agreement.snapshot();
      if (a.documentId === null)
        throw new WorkPayRuleError("Send the agreement for signature first");
      const document = (await deps.documentRecords.findById(a.documentId))!.snapshot();
      if (document.status !== "fully_signed")
        throw new WorkPayRuleError(
          `The agreement is not signed by everyone yet (${document.status.replaceAll("_", " ")})`,
        );
      const settings = await deps.settings.get();
      const assignment = await deps.assignments.startForWorkPay(actor, a.id, a.vehicleId, {
        driverId: a.driverId,
        odometer: handover.odometer,
        checklist: handover.checklist,
        notes: handover.notes ?? null,
      });
      agreement.activate({
        assignmentId: assignment.id,
        today: await deps.calendar.today(),
        userId: actor.userId,
        requireDeposit: settings.requireDeposit,
        now: deps.clock.now(),
      });
      await deps.agreements.save(agreement);
      await deps.schedule.create(a.id, this.schedule(a).schedule);
      const started = agreement.snapshot();
      await deps.posting.post(
        Postings.workpayStarted(
          started,
          {
            priceMinor: a.terms.totalPriceMinor,
            depositMinor: started.depositPaidMinor,
            date: started.startedOn!,
          },
          await deps.posting.accounts(),
        ),
        actor.userId,
      );
      await this.audit(actor, "workpay.agreement_activated", agreement);
      return this.view(agreement, true);
    });
  }

  async cancel(actor: Principal, id: string, reason: string): Promise<AgreementView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await this.reach(actor, id, "workpay.activate", true);
      const documentId = agreement.cancel(reason, deps.clock.now());
      await this.voidDocument(actor, documentId, `Agreement cancelled: ${reason}`);
      await deps.agreements.save(agreement);
      await this.audit(actor, "workpay.agreement_cancelled", agreement, { reason });
      return this.view(agreement, false);
    });
  }

  async list(
    actor: Principal,
    query: Readonly<{
      statuses?: readonly AgreementStatus[];
      driverId?: string;
      vehicleId?: string;
      branchId?: string;
      cursor?: string;
      limit: number;
    }>,
  ): Promise<Page<AgreementView>> {
    const { deps } = this;
    const after = query.cursor === undefined ? undefined : PageCursor.parse(query.cursor, 1).values;
    return deps.unitOfWork.run(async () => {
      if (query.branchId !== undefined)
        await deps.scope.branch(actor, "workpay.view", query.branchId);
      const rows = await deps.agreements.list({
        branchIds: deps.scope.branchesFor(actor, "workpay.view"),
        ...(query.branchId === undefined ? {} : { branchId: query.branchId }),
        ...(query.statuses === undefined ? {} : { statuses: query.statuses }),
        ...(query.driverId === undefined ? {} : { driverId: query.driverId }),
        ...(query.vehicleId === undefined ? {} : { vehicleId: query.vehicleId }),
        limit: query.limit + 1,
        ...(after === undefined ? {} : { afterId: String(after[0]) }),
      });
      const page = PageCursor.paginate(rows, query.limit, (r) => [r.id]);
      return { ...page, items: await Promise.all(page.items.map((a) => this.view(a, false))) };
    });
  }

  async get(actor: Principal, id: string): Promise<AgreementView> {
    return this.deps.unitOfWork.run(async () =>
      this.view(await this.reach(actor, id, "workpay.view"), true),
    );
  }

  /** A driver's own agreements with their schedules (driver app). */
  async ofDriver(driverId: string): Promise<AgreementView[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const rows = await deps.agreements.list({
        branchIds: "all",
        driverId,
        statuses: [
          "awaiting_signatures",
          ...LIVE_STATUSES,
          "completed",
          "restructured",
          "terminated",
          "repossessed",
        ],
        limit: 20,
      });
      return Promise.all(rows.map((a) => this.view(a, true)));
    });
  }

  // --- helpers ---

  private async terms(
    request: TermsRequest,
    vehicle: Awaited<ReturnType<VehicleAccess["reach"]>> | null,
  ): Promise<WorkPayTerms> {
    const { deps } = this;
    const base = await deps.posting.baseCurrency();
    const minor = (amount: string) => Money.parse(amount, base).amountMinor;
    const settings = await deps.settings.get();
    const today = await deps.calendar.today();
    const value =
      request.vehicleValue !== undefined
        ? minor(request.vehicleValue)
        : (vehicle?.bookValue(today, base)?.amountMinor ?? null);
    if (value === null)
      throw new WorkPayRuleError("Give the vehicle's value (it has no acquisition cost recorded)");
    const pricing: Pricing =
      request.pricing.kind === "total"
        ? { kind: "total", totalMinor: minor(request.pricing.total) }
        : request.pricing;
    return workPayTerms({
      vehicleValueMinor: value,
      pricing,
      depositMinor: request.deposit === undefined ? 0 : minor(request.deposit),
      frequency: request.frequency ?? settings.defaultFrequency,
      ...(request.periods === undefined ? {} : { periods: request.periods }),
      ...(request.months === undefined ? {} : { months: request.months }),
      firstDueOn: request.firstDueOn ?? TenantCalendar.addDays(today, settings.firstDueAfterDays),
      daysOff: request.daysOff ?? [],
      roundToMinor: request.roundTo === undefined ? settings.roundToMinor : minor(request.roundTo),
    });
  }

  private async penaltyRule(request: PenaltyRequest): Promise<PenaltyRule> {
    const base = await this.deps.posting.baseCurrency();
    const minor = (amount: string) => Money.parse(amount, base).amountMinor;
    switch (request.kind) {
      case "none":
      case "percent":
        return request;
      case "flat":
        return { kind: "flat", amountMinor: minor(request.amount) };
      case "daily":
        return {
          kind: "daily",
          amountMinor: minor(request.amount),
          capMinor: request.cap === undefined || request.cap === null ? null : minor(request.cap),
        };
    }
  }

  /** The schedule the stored terms give (the same the signed document shows). */
  private schedule(a: WorkPayAgreementProps): WorkPayTerms {
    return workPayTerms({
      vehicleValueMinor: a.terms.vehicleValueMinor,
      pricing: pricingOf(a.terms),
      depositMinor: a.terms.depositMinor,
      frequency: a.terms.frequency,
      periods: a.terms.periods,
      firstDueOn: a.terms.firstDueOn,
      daysOff: a.terms.daysOff,
      roundToMinor: a.terms.roundToMinor,
    });
  }

  private async assertFree(vehicleId: string, driverId: string, exceptId?: string): Promise<void> {
    const forVehicle = await this.deps.agreements.liveFor({ vehicleId });
    if (forVehicle !== null && forVehicle.id !== exceptId)
      throw new WorkPayRuleError(
        `This vehicle is already on agreement ${forVehicle.snapshot().number}`,
      );
    const forDriver = await this.deps.agreements.liveFor({ driverId });
    if (forDriver !== null && forDriver.id !== exceptId)
      throw new WorkPayRuleError(
        `This driver already has agreement ${forDriver.snapshot().number}`,
      );
  }

  private async voidDocument(actor: Principal, documentId: string | null, reason: string) {
    if (documentId !== null) await this.deps.documents.voidFor(actor.userId, documentId, reason);
  }

  private async reach(
    actor: Principal,
    id: string,
    permission: PermissionKey,
    lock = false,
  ): Promise<WorkPayAgreement> {
    const { deps } = this;
    const agreement = lock
      ? await deps.agreements.lockById(id)
      : await deps.agreements.findById(id);
    if (agreement === null) throw new AgreementNotFoundError();
    await deps.scope.assertReaches(
      actor,
      permission,
      agreement.snapshot().branchId,
      () => new AgreementNotFoundError(),
    );
    return agreement;
  }

  private async money(): Promise<(minor: number) => MoneyJson> {
    const base = await this.deps.posting.baseCurrency();
    return (minor) => Money.ofMinor(minor, base).toJSON();
  }

  private termsView(t: WorkPayTerms, m: (minor: number) => MoneyJson): TermsView {
    return {
      vehicleValue: m(t.vehicleValueMinor),
      pricing: t.pricing,
      totalPrice: m(t.totalPriceMinor),
      markup: m(t.markupMinor),
      deposit: m(t.depositMinor),
      financed: m(t.financedMinor),
      frequency: t.frequency,
      periods: t.periods,
      instalment: m(t.instalmentMinor),
      lastInstalment: m(t.lastInstalmentMinor),
      firstDueOn: t.firstDueOn,
      lastDueOn: t.lastDueOn,
      daysOff: t.daysOff,
    };
  }

  private async view(agreement: WorkPayAgreement, withSchedule: boolean): Promise<AgreementView> {
    const { deps } = this;
    const { terms, depositPaidMinor, ...rest } = agreement.snapshot();
    const m = await this.money();
    const computed = this.schedule(agreement.snapshot());
    const document =
      rest.documentId === null
        ? null
        : (await deps.documentRecords.findById(rest.documentId))?.snapshot();
    let schedule: InstalmentView[] | undefined;
    if (withSchedule) {
      const stored = await deps.schedule.list(rest.id);
      schedule =
        stored.length > 0
          ? stored.map((i) => ({
              number: i.number,
              dueOn: i.dueOn,
              amount: m(i.amountMinor),
              paid: m(i.paidMinor),
              status: i.status,
            }))
          : computed.schedule.map((i) => ({
              number: i.number,
              dueOn: i.dueOn,
              amount: m(i.amountMinor),
            }));
    }
    return {
      ...rest,
      terms: this.termsView(computed, m),
      lateFee: lateFee(rest.penalty, m),
      depositPaid: m(depositPaidMinor),
      depositOutstanding: m(terms.depositMinor - depositPaidMinor),
      document:
        document === undefined || document === null
          ? null
          : { id: document.id, number: document.number, status: document.status },
      ...(schedule === undefined ? {} : { schedule }),
    };
  }

  private async audit(
    actor: Principal,
    action: string,
    agreement: WorkPayAgreement,
    metadata: Readonly<Record<string, unknown>> = {},
  ) {
    const a = agreement.snapshot();
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: "workpay_agreement",
      entityId: a.id,
      after: { number: a.number, status: a.status, financedMinor: a.terms.financedMinor },
      metadata,
    });
  }
}
