import { FinanceRuleError, type LedgerPartyType } from "../../../domain/finance/Journal.js";
import { Payment, type PaymentMethod, type PaymentProps } from "../../../domain/finance/Payment.js";
import { Postings, toBase } from "../../../domain/finance/Postings.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type {
  Allocation,
  ICashSessionRepository,
  IInvoiceRepository,
  IPaymentRepository,
} from "../../../domain/repositories/IFinanceRepositories.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import type { Page } from "../../dto/Page.js";
import {
  CashSessionRequiredError,
  InvoiceNotFoundError,
  PaymentNotFoundError,
} from "../../errors/FinanceErrors.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type {
  IFinanceQueries,
  IFinanceSettingsStore,
  ILedger,
  IPaymentPurpose,
  IPaymentReversalListener,
  PaymentListFilter,
} from "../../ports/IFinanceRecords.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import type { BranchScope } from "../../services/BranchScope.js";
import { PageCursor } from "../../services/PageCursor.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { DocumentNumbering } from "../reference/DocumentNumbering.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { FinanceContext } from "./FinanceContext.js";
import type { LedgerPosting } from "./LedgerPosting.js";

export type PaymentRequest = Readonly<{
  direction: "in" | "out";
  method: PaymentMethod;
  partyType?: LedgerPartyType | null;
  partyId?: string | null;
  /** Money out to someone who is not a recorded party (a mechanic, the electricity company …). */
  partyName?: string | null;
  branchId?: string;
  paidOn?: string;
  currency?: string;
  fxRate?: string | null;
  amount: string;
  reference?: string | null;
  momoNetwork?: "mtn" | "telecel" | "at" | null;
  vehicleId?: string | null;
  notes?: string | null;
  /** Money out: the account it is for (default: the party's credit — a refund — or other expenses). */
  counterAccountId?: string | null;
  /** Money in: invoices to pay straight away. */
  allocations?: readonly Readonly<{ invoiceId: string; amount: string }>[];
}>;

/** Recorded by a module for one of its records (an expense …). */
export type SourcedPaymentRequest = PaymentRequest &
  Readonly<{ source: Readonly<{ type: string; id: string }> }>;

export type AllocationView = Omit<Allocation, "amountMinor"> &
  Readonly<{ amount: MoneyJson; invoiceNumber: string | null }>;

export type PaymentView = Omit<PaymentProps, "amountMinor" | "amountBaseMinor" | "allocatedMinor"> &
  Readonly<{
    amount: MoneyJson;
    amountBase: MoneyJson;
    allocated: MoneyJson;
    unallocated: MoneyJson;
    allocations?: readonly AllocationView[];
  }>;

export type ReceiptView = Readonly<{
  business: Readonly<{
    name: string;
    tin: string | null;
    phone: string | null;
    email: string | null;
  }>;
  number: string;
  date: string;
  receivedFrom: string;
  amount: MoneyJson;
  method: PaymentMethod;
  momoNetwork: PaymentProps["momoNetwork"];
  reference: string | null;
  /** What the money paid: invoices, or what the module that recorded it says (a remittance …). */
  appliedTo: readonly Readonly<{
    invoiceNumber: string | null;
    description: string;
    amount: MoneyJson;
  }>[];
  /** Kept as the payer's credit. */
  credit: MoneyJson;
  status: PaymentProps["status"];
}>;

export type PaymentQuery = Omit<PaymentListFilter, "branchIds" | "after" | "limit"> &
  Readonly<{ limit: number; cursor?: string }>;

/**
 * Recorded payments (docs/13 §2.2–2.3, decision 16: the money moved outside the system). Money in
 * is credited to the party and then allocated to invoices (any remainder stays as credit, usable
 * later); money out is a refund of credit or a payment for something (an expense account).
 * Cash goes through the cashier's open session. Corrections are reversals: allocations are
 * released, the payment's posting cancelled.
 */
export class PaymentRecording {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      payments: IPaymentRepository;
      invoices: IInvoiceRepository;
      sessions: ICashSessionRepository;
      queries: IFinanceQueries;
      ledger: ILedger;
      posting: LedgerPosting;
      context: FinanceContext;
      settings: IFinanceSettingsStore;
      organisation: IOrganisationSettings;
      vehicles: IVehicleRepository;
      scope: BranchScope;
      numbering: DocumentNumbering;
      calendar: TenantCalendar;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
      reversalListeners?: readonly IPaymentReversalListener[];
      /** Describe what module-recorded payments were for, on receipts. */
      purposes?: readonly IPaymentPurpose[];
    }>,
  ) {}

  async list(actor: Principal, query: PaymentQuery): Promise<Page<PaymentView>> {
    const { deps } = this;
    const after = query.cursor === undefined ? undefined : PageCursor.parse(query.cursor, 2).values;
    return deps.unitOfWork.run(async () => {
      const rows = await deps.queries.payments({
        ...query,
        branchIds: deps.scope.branchesFor(actor, "finance.payments.view"),
        limit: query.limit + 1,
        ...(after === undefined
          ? {}
          : { after: { recordedAt: String(after[0]), id: String(after[1]) } }),
      });
      const base = await deps.posting.baseCurrency();
      const page = PageCursor.paginate(rows, query.limit, (p) => [
        p.recordedAt.toISOString(),
        p.id,
      ]);
      return { ...page, items: page.items.map((p) => paymentView(p, base)) };
    });
  }

  async get(actor: Principal, id: string): Promise<PaymentView> {
    return this.deps.unitOfWork.run(async () => {
      const payment = await this.reach(actor, id, "finance.payments.view");
      return this.detail(payment);
    });
  }

  /**
   * Records money in or out. A module recording for one of its records (a rental's payment or
   * deposit …) checks the caller with its own `permission`.
   */
  async record(
    actor: Principal,
    request: PaymentRequest | SourcedPaymentRequest,
    permission: PermissionKey = "finance.payments.record",
  ): Promise<PaymentView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const branchId =
        request.branchId ?? (await deps.scope.defaultBranch(actor, permission, "payment"));
      await deps.scope.branch(actor, permission, branchId);
      const paidOn = request.paidOn ?? (await deps.calendar.today());
      await deps.posting.assertOpen(paidOn);
      const accounts = await deps.posting.accounts();
      const party =
        request.partyType !== undefined &&
        request.partyType !== null &&
        request.partyId !== undefined &&
        request.partyId !== null
          ? { type: request.partyType, id: request.partyId }
          : null;
      const partyName =
        party === null
          ? (request.partyName ?? "")
          : (await deps.context.party(party.type, party.id)).name;
      const { currency, fxRate, base } = await deps.context.rate(
        request.currency ?? (await deps.posting.baseCurrency()),
        paidOn,
        request.fxRate,
      );
      const amountMinor = Money.parse(request.amount, currency).amountMinor;
      const amountBaseMinor = toBase(amountMinor, currency, fxRate, base);
      const counterAccountId =
        request.direction === "in"
          ? null
          : await this.counterAccount(
              request.counterAccountId ?? null,
              party,
              amountBaseMinor,
              accounts("party_credit"),
              accounts("other_expenses"),
            );
      if (
        request.vehicleId !== undefined &&
        request.vehicleId !== null &&
        (await deps.vehicles.findById(request.vehicleId)) === null
      )
        throw new FinanceRuleError("That vehicle does not exist");

      const sessionId =
        request.method === "cash"
          ? await this.cashSession(actor, branchId, request.direction, amountBaseMinor)
          : null;
      const payment = Payment.record({
        id: deps.ids.next(),
        number: await deps.numbering.next(
          request.direction === "in" ? "receipt" : "payment",
          new Date(`${paidOn}T12:00:00Z`),
        ),
        direction: request.direction,
        method: request.method,
        party,
        partyName,
        branchId,
        paidOn,
        currency,
        fxRate,
        amountMinor,
        amountBaseMinor,
        counterAccountId,
        reference: request.reference ?? null,
        momoNetwork: request.momoNetwork ?? null,
        cashSessionId: sessionId,
        vehicleId: request.vehicleId ?? null,
        notes: request.notes ?? null,
        source: "source" in request ? request.source : null,
        recordedBy: actor.userId,
        recordedAt: deps.clock.now(),
      });
      await deps.payments.save(payment);
      await deps.posting.post(Postings.paymentRecorded(payment, accounts), actor.userId);
      for (const allocation of request.allocations ?? [])
        await this.applyTo(
          actor,
          payment,
          allocation.invoiceId,
          Money.parse(allocation.amount, currency).amountMinor,
        );
      await deps.payments.save(payment);
      await this.audit(actor, "payment.recorded", payment);
      return this.detail(payment);
    });
  }

  async allocate(
    actor: Principal,
    paymentId: string,
    input: Readonly<{ invoiceId: string; amount: string }>,
  ): Promise<PaymentView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const payment = await this.reach(actor, paymentId, "finance.payments.record", true);
      const amountMinor = Money.parse(input.amount, payment.snapshot().currency).amountMinor;
      await this.applyTo(actor, payment, input.invoiceId, amountMinor);
      await deps.payments.save(payment);
      return this.detail(payment);
    });
  }

  /**
   * Allocates part of a payment a module recorded (a rental's deposit or prepayment) to one of
   * its invoices; the module checked its own permission.
   */
  async allocateFor(
    actor: Principal,
    paymentId: string,
    invoiceId: string,
    amountMinor: number,
  ): Promise<PaymentView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const payment = await deps.payments.lockById(paymentId);
      if (payment === null) throw new PaymentNotFoundError();
      await this.applyTo(actor, payment, invoiceId, amountMinor);
      await deps.payments.save(payment);
      return this.detail(payment);
    });
  }

  async release(
    actor: Principal,
    paymentId: string,
    allocationId: string,
    reason: string,
  ): Promise<PaymentView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const payment = await this.reach(actor, paymentId, "finance.payments.reverse", true);
      const allocation = (await deps.payments.allocations({ paymentId })).find(
        (a) => a.id === allocationId && a.releasedAt === null,
      );
      if (allocation === undefined) throw new PaymentNotFoundError();
      await this.releaseAllocation(actor, payment, allocation, reason);
      await deps.payments.save(payment);
      return this.detail(payment);
    });
  }

  /** Reverses a payment: its allocations are released, its posting cancelled, the till adjusted. */
  async reverse(actor: Principal, id: string, reason: string): Promise<PaymentView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const payment = await this.reach(actor, id, "finance.payments.reverse", true);
      for (const allocation of await deps.payments.allocations({ paymentId: id }))
        if (allocation.releasedAt === null)
          await this.releaseAllocation(actor, payment, allocation, `Payment reversed: ${reason}`);
      payment.reverse(reason, actor.userId, deps.clock.now());
      const p = payment.snapshot();
      if (p.cashSessionId !== null) {
        const session = await deps.sessions.lockById(p.cashSessionId);
        // A closed till was counted already: the reversal is a ledger correction only.
        if (session !== null && session.snapshot().status === "open") {
          session.unrecord(p.direction, p.amountBaseMinor);
          await deps.sessions.save(session);
        }
      }
      await deps.posting.reverse(
        { type: "payment", id },
        await deps.calendar.today(),
        `${p.number} reversed: ${reason}`,
        actor.userId,
      );
      await deps.payments.save(payment);
      if (p.source !== null)
        for (const listener of deps.reversalListeners ?? [])
          if (listener.sourceType === p.source.type)
            await listener.paymentReversed(p.source.id, id);
      await this.audit(actor, "payment.reversed", payment, { reason });
      return this.detail(payment);
    });
  }

  async receipt(actor: Principal, id: string): Promise<ReceiptView> {
    return this.deps.unitOfWork.run(async () =>
      this.receiptOf(await this.reach(actor, id, "finance.payments.view")),
    );
  }

  /** The receipt of a payment the party made (their own app); others' do not exist for them. */
  async receiptForParty(
    party: Readonly<{ type: LedgerPartyType; id: string }>,
    id: string,
  ): Promise<ReceiptView> {
    return this.deps.unitOfWork.run(async () => {
      const payment = await this.deps.payments.findById(id);
      const p = payment?.snapshot();
      if (
        payment === null ||
        p?.direction !== "in" ||
        p.party?.type !== party.type ||
        p.party.id !== party.id
      )
        throw new PaymentNotFoundError();
      return this.receiptOf(payment);
    });
  }

  private async receiptOf(payment: Payment): Promise<ReceiptView> {
    const { deps } = this;
    const p = payment.snapshot();
    if (p.direction !== "in") throw new FinanceRuleError("Receipts are for money received");
    const organisation = await deps.organisation.get();
    const view = await this.detail(payment);
    const invoices = (view.allocations ?? [])
      .filter((a) => a.releasedAt === null)
      .map((a) => ({
        invoiceNumber: a.invoiceNumber,
        description: a.invoiceNumber === null ? "Invoice" : `Invoice ${a.invoiceNumber}`,
        amount: a.amount,
      }));
    const purpose =
      p.source === null || p.status === "reversed"
        ? null
        : ((await deps.purposes
            ?.find((x) => x.sourceType === p.source!.type)
            ?.describe(p.source.id, p.id)) ?? null);
    const money = (minor: number) => Money.ofMinor(minor, p.currency).toJSON();
    return {
      business: {
        name: organisation.legalName ?? organisation.name,
        tin: organisation.tin,
        phone: organisation.contactPhone,
        email: organisation.contactEmail,
      },
      number: p.number,
      date: p.paidOn,
      receivedFrom: p.partyName,
      amount: view.amount,
      method: p.method,
      momoNetwork: p.momoNetwork,
      reference: p.reference,
      appliedTo:
        purpose === null
          ? invoices
          : [
              ...invoices,
              {
                invoiceNumber: null,
                description: purpose.description,
                amount: money(purpose.settledMinor),
              },
            ],
      credit:
        purpose === null
          ? view.unallocated
          : money(view.unallocated.amountMinor - purpose.settledMinor),
      status: p.status,
    };
  }

  private async reach(
    actor: Principal,
    id: string,
    permission: PermissionKey,
    lock = false,
  ): Promise<Payment> {
    const payment = lock
      ? await this.deps.payments.lockById(id)
      : await this.deps.payments.findById(id);
    if (payment === null) throw new PaymentNotFoundError();
    await this.deps.scope.assertReaches(
      actor,
      permission,
      payment.snapshot().branchId,
      () => new PaymentNotFoundError(),
    );
    return payment;
  }

  /** Allocates part of a (locked) payment to an invoice of the same party and currency. */
  private async applyTo(
    actor: Principal,
    payment: Payment,
    invoiceId: string,
    amountMinor: number,
  ): Promise<void> {
    const { deps } = this;
    const invoice = await deps.invoices.lockById(invoiceId);
    if (invoice === null) throw new InvoiceNotFoundError();
    const pay = payment.snapshot();
    const inv = invoice.snapshot();
    if (pay.party?.type !== inv.partyType || pay.party.id !== inv.partyId)
      throw new FinanceRuleError("A payment pays invoices of the same customer or driver");
    if (pay.currency !== inv.currency)
      throw new FinanceRuleError(
        `This invoice is in ${inv.currency}; the payment is in ${pay.currency}`,
      );
    const now = deps.clock.now();
    payment.allocate(amountMinor);
    invoice.applyPayment(amountMinor, now);
    const date = await deps.calendar.today();
    const allocation: Allocation = {
      id: deps.ids.next(),
      paymentId: pay.id,
      invoiceId,
      amountMinor,
      allocatedAt: now,
      allocatedBy: actor.userId,
      releasedAt: null,
      releasedBy: null,
      releaseReason: null,
    };
    await deps.payments.saveAllocation(allocation);
    await deps.posting.post(
      Postings.allocation(
        {
          allocationId: allocation.id,
          payment,
          invoice,
          amountMinor,
          date: date < pay.paidOn ? pay.paidOn : date,
        },
        await deps.posting.accounts(),
        await deps.posting.baseCurrency(),
      ),
      actor.userId,
    );
    await deps.invoices.save(invoice);
    await recordUserAction(deps, actor.userId, {
      action: "payment.allocated",
      entityType: "payment",
      entityId: pay.id,
      after: { invoiceId, invoiceNumber: inv.number, amountMinor, allocationId: allocation.id },
    });
  }

  private async releaseAllocation(
    actor: Principal,
    payment: Payment,
    allocation: Allocation,
    reason: string,
  ): Promise<void> {
    const { deps } = this;
    if (reason.trim().length < 3) throw new FinanceRuleError("Give a reason for releasing it");
    const invoice = await deps.invoices.lockById(allocation.invoiceId);
    if (invoice === null) throw new InvoiceNotFoundError();
    const now = deps.clock.now();
    payment.release(allocation.amountMinor);
    invoice.releasePayment(allocation.amountMinor, now);
    await deps.payments.saveAllocation({
      ...allocation,
      releasedAt: now,
      releasedBy: actor.userId,
      releaseReason: reason.trim(),
    });
    await deps.posting.reverse(
      { type: "allocation", id: allocation.id },
      await deps.calendar.today(),
      `Allocation released: ${reason}`,
      actor.userId,
    );
    await deps.invoices.save(invoice);
    await recordUserAction(deps, actor.userId, {
      action: "payment.allocation_released",
      entityType: "payment",
      entityId: payment.id,
      before: { invoiceId: allocation.invoiceId, amountMinor: allocation.amountMinor },
      metadata: { reason },
    });
  }

  /** The counter account of money out; a refund cannot exceed the party's credit. */
  private async counterAccount(
    requested: string | null,
    party: Readonly<{ type: LedgerPartyType; id: string }> | null,
    amountBaseMinor: number,
    partyCredit: string,
    otherExpenses: string,
  ): Promise<string> {
    const { deps } = this;
    const accountId =
      requested ?? (party !== null && party.type !== "supplier" ? partyCredit : otherExpenses);
    const account = (await deps.ledger.accounts()).find((a) => a.id === accountId);
    if (
      account === undefined ||
      !account.active ||
      !["expense", "liability", "asset"].includes(account.type)
    )
      throw new FinanceRuleError("Money out goes to an expense, a liability or an asset account");
    if (accountId === partyCredit) {
      if (party === null) throw new FinanceRuleError("A refund goes to a customer or driver");
      const credit = -(await deps.ledger.partyBalance(partyCredit, party));
      if (amountBaseMinor > credit)
        throw new FinanceRuleError("The refund is more than the credit this party has");
    }
    return accountId;
  }

  /** The cashier's open session in this branch takes the cash (when the business requires it). */
  private async cashSession(
    actor: Principal,
    branchId: string,
    direction: "in" | "out",
    amountBaseMinor: number,
  ): Promise<string | null> {
    const { deps } = this;
    const session = await deps.sessions.lockOpenFor(actor.userId);
    if (session === null || session.snapshot().branchId !== branchId) {
      if ((await deps.settings.get()).requireCashSession) throw new CashSessionRequiredError();
      return null;
    }
    session.record(direction, amountBaseMinor);
    await deps.sessions.save(session);
    return session.id;
  }

  private async detail(payment: Payment): Promise<PaymentView> {
    const { deps } = this;
    const allocations = await deps.payments.allocations({ paymentId: payment.id });
    const numbers = new Map<string, string | null>();
    for (const a of allocations)
      if (!numbers.has(a.invoiceId))
        numbers.set(
          a.invoiceId,
          (await deps.invoices.findById(a.invoiceId))?.snapshot().number ?? null,
        );
    const p = payment.snapshot();
    return {
      ...paymentView(p, await deps.posting.baseCurrency()),
      allocations: allocations.map(({ amountMinor, ...a }) => ({
        ...a,
        amount: Money.ofMinor(amountMinor, p.currency).toJSON(),
        invoiceNumber: numbers.get(a.invoiceId) ?? null,
      })),
    };
  }

  private async audit(
    actor: Principal,
    action: string,
    payment: Payment,
    metadata?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const p = payment.snapshot();
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: "payment",
      entityId: p.id,
      after: {
        number: p.number,
        direction: p.direction,
        method: p.method,
        amountMinor: p.amountMinor,
        currency: p.currency,
        party: p.party,
        status: p.status,
      },
      ...(metadata === undefined ? {} : { metadata }),
    });
  }
}

export function paymentView(p: PaymentProps, base: string): PaymentView {
  const { amountMinor, amountBaseMinor, allocatedMinor, ...rest } = p;
  const m = (minor: number) => Money.ofMinor(minor, p.currency).toJSON();
  return {
    ...rest,
    amount: m(amountMinor),
    amountBase: Money.ofMinor(amountBaseMinor, base).toJSON(),
    allocated: m(allocatedMinor),
    unallocated: m(amountMinor - allocatedMinor),
  };
}
