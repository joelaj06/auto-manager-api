import type { IExpenseDriverCosts } from "../../ports/IExpenseDriverCosts.js";
import type { IExpenseSourceHook } from "../../ports/IExpenseSourceHooks.js";
import {
  Expense,
  ExpenseRuleError,
  type ExpenseDetails,
  type ExpenseProps,
  type PayeeType,
} from "../../../domain/expenses/Expense.js";
import { matchingRule } from "../../../domain/expenses/ExpenseRules.js";
import { Postings } from "../../../domain/finance/Postings.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { IExpenseRepository } from "../../../domain/repositories/IExpenseRepository.js";
import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import { TaxCode } from "../../../domain/tax/TaxCode.js";
import type { AuthorizationPolicy } from "../../authorization/AuthorizationPolicy.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import type { Page } from "../../dto/Page.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type {
  ExpenseListFilter,
  IApprovalRules,
  IExpenseQueries,
  IExpenseSettingsStore,
} from "../../ports/IExpenseRecords.js";
import type { IPartyDirectory } from "../../ports/IFinanceRecords.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { ITenantReferenceData } from "../../ports/IReferenceData.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import { PageCursor } from "../../services/PageCursor.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { FileView, UploadStarted } from "../files/FileService.js";
import type { DocumentUploadInput, OwnedDocuments } from "../files/OwnedDocuments.js";
import type { FinanceContext } from "../finance/FinanceContext.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { PaymentRecording } from "../finance/PaymentRecording.js";
import type { PaymentMethod } from "../../../domain/finance/Payment.js";
import type { DocumentNumbering } from "../reference/DocumentNumbering.js";
import { recordAction, recordUserAction } from "../reference/userAudit.js";

export class ExpenseNotFoundError extends ApplicationError {
  readonly code = "EXPENSE_NOT_FOUND";
  constructor() {
    super("Expense not found");
  }
}

/** Above the approver's role limit (`expenses.approve` max_amount_minor) — 403. */
export class ApprovalLimitError extends ApplicationError {
  readonly code = "APPROVAL_LIMIT_EXCEEDED";
  constructor(limit: string) {
    super(`This is above your approval limit of ${limit}; ask someone with a higher limit`);
  }
}

/** As sent by clients: amounts as decimal strings in the expense's currency (default: base). */
export type ExpenseRequest = Readonly<{
  categoryId: string;
  description: string;
  branchId?: string;
  expenseDate?: string;
  payeeType?: PayeeType | null;
  payeeId?: string | null;
  payeeName?: string | null;
  driverId?: string | null;
  chargeToDriver?: boolean;
  amount: string;
  /** An enabled currency (default: the base currency). */
  currency?: string;
  /** Base units per 1 unit of `currency` (default: the rate entered for the expense date). */
  fxRate?: string | null;
  /** Purchase tax included in the amount (VAT-registered businesses only). */
  taxCode?: string | null;
  /** Split equally across these vehicles. */
  vehicleIds?: readonly string[];
  /** Or split by amounts (adding up to the total). */
  split?: readonly Readonly<{ vehicleId: string; amount: string }>[];
  reference?: string | null;
  notes?: string | null;
}>;

export type ExpenseView = Omit<
  ExpenseProps,
  | "amountMinor"
  | "netMinor"
  | "taxMinor"
  | "amountBaseMinor"
  | "netBaseMinor"
  | "taxBaseMinor"
  | "fxDifferenceMinor"
  | "lines"
  | "taxComponents"
> &
  Readonly<{
    amount: MoneyJson;
    net: MoneyJson;
    tax: MoneyJson;
    /** In the base currency at the expense's rate (the same as `amount` in the base currency). */
    amountBase: MoneyJson;
    netBase: MoneyJson;
    taxBase: MoneyJson;
    /** Paid at another rate: the exchange gain (positive) or loss (negative). */
    fxDifference: MoneyJson;
    taxComponents: readonly Readonly<{
      key: string;
      name: string;
      rate: string;
      amount: MoneyJson;
    }>[];
    lines: readonly Readonly<{
      vehicleId: string | null;
      amount: MoneyJson;
      net: MoneyJson;
      tax: MoneyJson;
      amountBase: MoneyJson;
    }>[];
    receipts?: readonly FileView[];
  }>;

export type ExpenseResult = Readonly<{
  expense: ExpenseView;
  /** Possible duplicates and other things worth a second look. */
  warnings: readonly string[];
}>;

export type ExpenseQuery = Omit<ExpenseListFilter, "branchIds" | "createdBy" | "after" | "limit"> &
  Readonly<{ limit: number; cursor?: string }>;

export type PayExpenseInput = Readonly<{
  method: PaymentMethod;
  momoNetwork?: "mtn" | "telecel" | "at" | null;
  reference?: string | null;
  paidOn?: string;
  /** The rate on the payment date for a foreign-currency expense (default: the one entered). */
  fxRate?: string | null;
}>;

/**
 * Expenses (docs/12 §8): entered (split across vehicles if shared), submitted — approval rules
 * may approve automatically, otherwise someone else with a high enough limit approves or
 * rejects — then paid through finance. Approval posts the cost (or charges the driver who bears
 * it) against what is owed to the payee; recoverable input VAT goes to its account. Receipts
 * are attached as scans; duplicates are flagged.
 */
export class Expenses {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      expenses: IExpenseRepository;
      queries: IExpenseQueries;
      rules: IApprovalRules;
      settings: IExpenseSettingsStore;
      reference: ITenantReferenceData;
      organisation: IOrganisationSettings;
      vehicles: IVehicleRepository;
      parties: IPartyDirectory;
      posting: LedgerPosting;
      context: FinanceContext;
      payments: PaymentRecording;
      receipts: OwnedDocuments;
      policy: AuthorizationPolicy;
      scope: BranchScope;
      numbering: DocumentNumbering;
      calendar: TenantCalendar;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
      /** Who bears expenses by default and what follows their approval (work and pay). */
      driverCosts?: IExpenseDriverCosts;
      /** Modules following what their expenses posted (purchases). */
      sourceHooks?: readonly IExpenseSourceHook[];
    }>,
  ) {}

  async list(actor: Principal, query: ExpenseQuery): Promise<Page<ExpenseView>> {
    const { deps } = this;
    const after = query.cursor === undefined ? undefined : PageCursor.parse(query.cursor, 2).values;
    return deps.unitOfWork.run(async () => {
      const own = actor.grantFor("expenses.list")?.scope === "own";
      const rows = await deps.queries.list({
        ...query,
        branchIds: own ? "all" : deps.scope.branchesFor(actor, "expenses.list"),
        ...(own ? { createdBy: actor.userId } : {}),
        limit: query.limit + 1,
        ...(after === undefined
          ? {}
          : { after: { createdAt: String(after[0]), id: String(after[1]) } }),
      });
      const base = await deps.posting.baseCurrency();
      const page = PageCursor.paginate(rows, query.limit, (e) => [e.createdAt.toISOString(), e.id]);
      return { ...page, items: page.items.map((e) => expenseView(e, base)) };
    });
  }

  async get(actor: Principal, id: string): Promise<ExpenseView> {
    const view = await this.deps.unitOfWork.run(async () =>
      expenseView((await this.reach(actor, id, "expenses.view")).snapshot(), await this.base()),
    );
    return { ...view, receipts: await this.deps.receipts.list(id) };
  }

  async create(actor: Principal, request: ExpenseRequest): Promise<ExpenseResult> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const branchId =
        request.branchId ?? (await deps.scope.defaultBranch(actor, "expenses.create", "expense"));
      await deps.scope.branch(actor, "expenses.create", branchId);
      const expense = await this.draftFor(actor.userId, request, branchId, null, actor);
      return {
        expense: expenseView(expense.snapshot(), await this.base()),
        warnings: await this.warnings(expense),
      };
    });
  }

  /**
   * A draft created by a module (fuel log, recurring expense) for `userId` — no permission
   * check; call inside a unit of work.
   */
  async draftFor(
    userId: string | null,
    request: ExpenseRequest,
    branchId: string,
    source: Readonly<{ type: string; id: string }> | null,
    actor: Principal | null = null,
  ): Promise<Expense> {
    const { deps } = this;
    const { details, amount, currency } = await this.prepare(request, branchId, actor);
    const expense = Expense.draft({
      id: deps.ids.next(),
      details,
      amount,
      currency,
      source,
      createdBy: userId,
      now: deps.clock.now(),
    });
    await deps.expenses.save(expense);
    await recordAction(deps, userId, {
      action: "expense.drafted",
      entityType: "expense",
      entityId: expense.id,
      after: summary(expense),
    });
    return expense;
  }

  async revise(actor: Principal, id: string, request: ExpenseRequest): Promise<ExpenseResult> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const expense = await this.reach(actor, id, "expenses.create", true);
      const branchId = request.branchId ?? expense.snapshot().branchId;
      await deps.scope.branch(actor, "expenses.create", branchId);
      const { details, amount, currency } = await this.prepare(request, branchId, actor);
      expense.revise(details, amount, currency, deps.clock.now());
      await deps.expenses.save(expense);
      await this.audit(actor, "expense.revised", expense);
      return {
        expense: expenseView(expense.snapshot(), await this.base()),
        warnings: await this.warnings(expense),
      };
    });
  }

  async deleteDraft(actor: Principal, id: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const expense = await this.reach(actor, id, "expenses.create", true);
      if (expense.status !== "draft")
        throw new ExpenseRuleError("Only a draft is deleted; void it instead");
      for (const file of await deps.receipts.list(id)) await deps.receipts.remove(id, file.id);
      await deps.expenses.deleteDraft(id);
      await this.audit(actor, "expense.draft_deleted", expense);
    });
  }

  /** Submits for approval; an approval rule may approve it straight away. */
  async submit(actor: Principal, id: string): Promise<ExpenseView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const expense = await this.reach(actor, id, "expenses.create", true);
      await this.submitLoaded(expense, actor.userId);
      return expenseView(expense.snapshot(), await this.base());
    });
  }

  /**
   * Submits a locked expense (shared with modules: fuel logs, recurring expenses). Modules whose
   * receipt comes later (a fuel fill entered at the pump) skip the receipt rule.
   */
  async submitLoaded(
    expense: Expense,
    userId: string | null,
    options: Readonly<{ skipReceiptRule?: boolean }> = {},
  ): Promise<void> {
    const { deps } = this;
    const p = expense.snapshot();
    const settings = await deps.settings.get();
    if (
      options.skipReceiptRule !== true &&
      settings.receiptRequiredAboveMinor !== null &&
      p.amountBaseMinor > settings.receiptRequiredAboveMinor &&
      (await deps.receipts.list(p.id)).length === 0
    )
      throw new ExpenseRuleError(
        `Attach the receipt: it is required above ${Money.ofMinor(settings.receiptRequiredAboveMinor, await this.base()).format()}`,
      );
    const now = deps.clock.now();
    expense.submit(
      await deps.numbering.next("expense", new Date(`${p.expenseDate}T12:00:00Z`)),
      userId,
      now,
    );
    const category = await deps.reference.expenseCategory(p.categoryId);
    const rule = matchingRule(await deps.rules.list(), {
      amountMinor: p.amountBaseMinor,
      branchId: p.branchId,
      categoryIds: [
        p.categoryId,
        ...(category?.parentId === null || category === null ? [] : [category.parentId]),
      ],
    });
    if (rule?.action === "auto_approve") {
      expense.approve(null, rule.id, now);
      await this.post(expense, userId);
    }
    await deps.expenses.save(expense);
    if (expense.status === "approved") await this.postingChanged(expense);
    await recordAction(deps, userId, {
      action: rule?.action === "auto_approve" ? "expense.auto_approved" : "expense.submitted",
      entityType: "expense",
      entityId: p.id,
      after: summary(expense),
      ...(rule === null ? {} : { metadata: { ruleId: rule.id, rule: rule.name } }),
    });
  }

  async approve(actor: Principal, id: string): Promise<ExpenseView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const expense = await this.reach(actor, id, "expenses.approve", true);
      const limit = deps.policy.limit(actor, "expenses.approve", "max_amount_minor");
      if (limit !== undefined && expense.snapshot().amountBaseMinor > limit)
        throw new ApprovalLimitError(Money.ofMinor(limit, await this.base()).format());
      expense.approve(actor.userId, null, deps.clock.now());
      await this.post(expense, actor.userId);
      await deps.expenses.save(expense);
      await this.postingChanged(expense);
      await this.audit(actor, "expense.approved", expense);
      return expenseView(expense.snapshot(), await this.base());
    });
  }

  async reject(actor: Principal, id: string, reason: string): Promise<ExpenseView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const expense = await this.reach(actor, id, "expenses.approve", true);
      expense.reject(actor.userId, reason, deps.clock.now());
      await deps.expenses.save(expense);
      await this.audit(actor, "expense.rejected", expense, { reason });
      return expenseView(expense.snapshot(), await this.base());
    });
  }

  /**
   * Pays an approved expense through finance (a payment out to the payee) in its currency. At a
   * rate other than the expense's, what is owed is cleared at the expense's base amount and the
   * difference is an exchange gain or loss (decision 411).
   */
  async pay(actor: Principal, id: string, input: PayExpenseInput): Promise<ExpenseView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const expense = await this.reach(actor, id, "expenses.pay", true);
      const p = expense.snapshot();
      if (p.status !== "approved")
        throw new ExpenseRuleError("Only an approved, unpaid expense can be paid");
      const accounts = await deps.posting.accounts();
      const base = await this.base();
      const payment = await deps.payments.record(actor, {
        direction: "out",
        method: input.method,
        ...(p.payee === null
          ? { partyName: p.payeeName }
          : { partyType: p.payee.type, partyId: p.payee.id }),
        branchId: p.branchId,
        amount: Money.ofMinor(p.amountMinor, p.currency).toDecimalString(),
        currency: p.currency,
        fxRate: input.fxRate ?? null,
        counterAccountId: accounts("payables"),
        reference: input.reference ?? p.reference,
        momoNetwork: input.momoNetwork ?? null,
        notes: `Expense ${p.number ?? ""}: ${p.description}`,
        ...(input.paidOn === undefined ? {} : { paidOn: input.paidOn }),
        source: { type: "expense", id },
      });
      const difference = p.amountBaseMinor - payment.amountBase.amountMinor;
      if (difference !== 0)
        await deps.posting.post(
          Postings.payableExchangeDifference(
            {
              paymentId: payment.id,
              difference,
              branchId: p.branchId,
              party: p.payee === null ? null : { type: p.payee.type, id: p.payee.id },
              date: payment.paidOn,
              description: `Exchange difference on expense ${p.number ?? ""} paid in ${p.currency}`,
            },
            accounts,
          ),
          actor.userId,
        );
      expense.markPaid(payment.id, deps.clock.now(), difference);
      await deps.expenses.save(expense);
      await this.audit(actor, "expense.paid", expense, {
        paymentId: payment.id,
        ...(difference === 0 ? {} : { fxDifferenceMinor: difference }),
      });
      return expenseView(expense.snapshot(), base);
    });
  }

  async void(actor: Principal, id: string, reason: string): Promise<ExpenseView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const expense = await this.reach(actor, id, "expenses.void", true);
      await this.voidLoaded(expense, actor.userId, reason);
      await this.audit(actor, "expense.voided", expense, { reason });
      return expenseView(expense.snapshot(), await this.base());
    });
  }

  /** Voids an expense a module raised (a purchase cost removed), unless it was paid. */
  async voidFor(id: string, userId: string | null, reason: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const expense = await deps.expenses.lockById(id);
      if (expense === null) throw new ExpenseNotFoundError();
      await this.voidLoaded(expense, userId, reason);
      await recordAction(deps, userId, {
        action: "expense.voided",
        entityType: "expense",
        entityId: id,
        metadata: { reason },
      });
    });
  }

  private async voidLoaded(expense: Expense, userId: string | null, reason: string): Promise<void> {
    const { deps } = this;
    const wasApproved = expense.status === "approved";
    expense.void(userId, reason, deps.clock.now());
    await deps.expenses.save(expense);
    if (wasApproved) {
      await deps.posting.reverse(
        { type: "expense", id: expense.id },
        await deps.calendar.today(),
        `Expense ${expense.snapshot().number ?? ""} voided: ${reason}`,
        userId,
      );
      await deps.driverCosts?.voided(expense.snapshot(), userId);
      await this.postingChanged(expense);
    }
  }

  /** Tells the module that raised the expense its posting changed. */
  private async postingChanged(expense: Expense): Promise<void> {
    const { sourceType, sourceId } = expense.snapshot();
    if (sourceType === null || sourceId === null) return;
    for (const hook of this.deps.sourceHooks ?? [])
      if (hook.sourceType === sourceType) await hook.postingChanged(sourceId);
  }

  async startReceipt(
    actor: Principal,
    id: string,
    input: DocumentUploadInput,
  ): Promise<UploadStarted> {
    await this.deps.unitOfWork.run(() => this.reach(actor, id, "expenses.create"));
    return this.deps.receipts.start(id, input, actor.userId);
  }

  async completeReceipt(actor: Principal, id: string, fileId: string): Promise<FileView> {
    await this.deps.unitOfWork.run(() => this.reach(actor, id, "expenses.create"));
    return this.deps.receipts.complete(id, fileId);
  }

  async removeReceipt(actor: Principal, id: string, fileId: string): Promise<void> {
    const expense = await this.deps.unitOfWork.run(() => this.reach(actor, id, "expenses.create"));
    if (expense.status !== "draft" && expense.status !== "rejected")
      throw new ExpenseRuleError("Receipts of a submitted expense stay attached");
    await this.deps.receipts.remove(id, fileId);
  }

  /** Posts an approved expense (call inside its unit of work). */
  private async post(expense: Expense, userId: string | null): Promise<void> {
    const { deps } = this;
    const p = expense.snapshot();
    const accounts = await deps.posting.accounts();
    const category = await deps.reference.expenseCategory(p.categoryId);
    const expenseAccount =
      category?.ledgerAccountId ??
      accounts(p.lines.some((l) => l.vehicleId !== null) ? "vehicle_expenses" : "other_expenses");
    const tax = await deps.organisation.taxSettings();
    const recoverTax = tax.scheme !== "not_registered";
    await deps.posting.post(
      Postings.expenseApproved(expense, expenseAccount, recoverTax, accounts, p.expenseDate),
      userId,
    );
    if (p.chargeToDriver)
      await deps.driverCosts?.approved(
        p,
        p.lines.reduce((sum, l) => sum + (recoverTax ? l.netBaseMinor : l.amountBaseMinor), 0),
        userId,
      );
  }

  /** The expense within the caller's reach for `permission` (own: only what they entered). */
  private async reach(
    actor: Principal,
    id: string,
    permission: PermissionKey,
    lock = false,
  ): Promise<Expense> {
    const { deps } = this;
    const expense = lock ? await deps.expenses.lockById(id) : await deps.expenses.findById(id);
    if (expense === null) throw new ExpenseNotFoundError();
    const p = expense.snapshot();
    if (actor.grantFor(permission)?.scope === "own") {
      if (p.createdBy !== actor.userId) throw new ExpenseNotFoundError();
      return expense;
    }
    await deps.scope.assertReaches(actor, permission, p.branchId, () => new ExpenseNotFoundError());
    return expense;
  }

  private async prepare(request: ExpenseRequest, branchId: string, actor: Principal | null) {
    const { deps } = this;
    const expenseDate = request.expenseDate ?? (await deps.calendar.today());
    const money = await deps.context.rate(
      request.currency ?? (await this.base()),
      expenseDate,
      request.fxRate,
      actor,
    );
    const { currency } = money;
    const category = await deps.reference.expenseCategory(request.categoryId);
    if (category === null || !category.active)
      throw new ExpenseRuleError("Choose an active expense category");
    const payee =
      request.payeeType !== undefined &&
      request.payeeType !== null &&
      request.payeeId !== undefined &&
      request.payeeId !== null
        ? { type: request.payeeType, id: request.payeeId }
        : null;
    if (payee !== null && (await deps.parties.find(payee.type, payee.id)) === null)
      throw new ExpenseRuleError(`That ${payee.type} does not exist`);
    let driverId = request.driverId ?? null;
    let chargeToDriver = request.chargeToDriver ?? false;
    if (request.chargeToDriver === undefined && deps.driverCosts !== undefined) {
      // A driver whose agreement makes them responsible for this cost bears it.
      const vehicleIds = [
        ...new Set([
          ...(request.vehicleIds ?? []),
          ...(request.split ?? []).map((x) => x.vehicleId),
        ]),
      ];
      const bearer = await deps.driverCosts.defaultBearer({
        categoryCode: category.code,
        vehicleIds,
      });
      if (bearer !== null && (driverId === null || driverId === bearer)) {
        driverId = bearer;
        chargeToDriver = true;
      }
    }
    if (driverId !== null && (await deps.parties.find("driver", driverId)) === null)
      throw new ExpenseRuleError("That driver does not exist");

    const amountMinor = Money.parse(request.amount, currency).amountMinor;
    let taxCode: TaxCode | null = null;
    if (request.taxCode !== undefined && request.taxCode !== null) {
      if ((await deps.organisation.taxSettings()).scheme === "not_registered")
        throw new ExpenseRuleError("Only VAT-registered businesses recover purchase tax");
      const props = await deps.reference.taxCode(request.taxCode);
      if (props === null || !props.active || !props.appliesTo.includes("purchases"))
        throw new ExpenseRuleError(`${request.taxCode} is not an active purchase tax code`);
      taxCode = TaxCode.create(props);
    }

    let split: { vehicleId: string; weight: number }[] = [];
    if (request.split !== undefined && request.split.length > 0) {
      split = request.split.map((s) => ({
        vehicleId: s.vehicleId,
        weight: Money.parse(s.amount, currency).amountMinor,
      }));
      if (split.reduce((sum, s) => sum + s.weight, 0) !== amountMinor)
        throw new ExpenseRuleError("The split amounts must add up to the total");
    } else if (request.vehicleIds !== undefined) {
      split = request.vehicleIds.map((vehicleId) => ({ vehicleId, weight: 1 }));
    }
    for (const s of split)
      if ((await deps.vehicles.findById(s.vehicleId)) === null)
        throw new ExpenseRuleError("One of the vehicles does not exist");

    const details: ExpenseDetails = {
      categoryId: category.id,
      description: request.description,
      branchId,
      expenseDate,
      payee,
      payeeName:
        payee === null
          ? (request.payeeName ?? null)
          : ((await deps.parties.find(payee.type, payee.id))?.name ?? null),
      driverId,
      chargeToDriver,
      reference: request.reference ?? null,
      notes: request.notes ?? null,
    };
    return { details, amount: { amountMinor, taxCode, split }, currency: money };
  }

  private async warnings(expense: Expense): Promise<string[]> {
    const p = expense.snapshot();
    const similar = await this.deps.queries.similar(p);
    return similar.map(
      (s) =>
        `Looks like ${s.number ?? "a draft"} (${s.description}): same category, date and amount`,
    );
  }

  baseCurrency(): Promise<string> {
    return this.deps.posting.baseCurrency();
  }

  private async base(): Promise<string> {
    return this.deps.posting.baseCurrency();
  }

  private async audit(
    actor: Principal,
    action: string,
    expense: Expense,
    metadata?: Readonly<Record<string, unknown>>,
  ) {
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: "expense",
      entityId: expense.id,
      after: summary(expense),
      ...(metadata === undefined ? {} : { metadata }),
    });
  }
}

function summary(expense: Expense) {
  const p = expense.snapshot();
  return {
    number: p.number,
    status: p.status,
    categoryId: p.categoryId,
    currency: p.currency,
    amountMinor: p.amountMinor,
    amountBaseMinor: p.amountBaseMinor,
    payee: p.payee,
    payeeName: p.payeeName,
    vehicles: p.lines.map((l) => l.vehicleId).filter((v) => v !== null),
  };
}

/** An expense for clients: amounts in its currency, and in `base` at its rate. */
export function expenseView(p: ExpenseProps, base: string): ExpenseView {
  const m = (minor: number) => Money.ofMinor(minor, p.currency).toJSON();
  const b = (minor: number) => Money.ofMinor(minor, base).toJSON();
  const {
    amountMinor,
    netMinor,
    taxMinor,
    amountBaseMinor,
    netBaseMinor,
    taxBaseMinor,
    fxDifferenceMinor,
    lines,
    taxComponents,
    ...rest
  } = p;
  return {
    ...rest,
    amount: m(amountMinor),
    net: m(netMinor),
    tax: m(taxMinor),
    amountBase: b(amountBaseMinor),
    netBase: b(netBaseMinor),
    taxBase: b(taxBaseMinor),
    fxDifference: b(fxDifferenceMinor),
    taxComponents: taxComponents.map(({ amountMinor: a, ...c }) => ({ ...c, amount: m(a) })),
    lines: lines.map((l) => ({
      vehicleId: l.vehicleId,
      amount: m(l.amountMinor),
      net: m(l.netMinor),
      tax: m(l.taxMinor),
      amountBase: b(l.amountBaseMinor),
    })),
  };
}
