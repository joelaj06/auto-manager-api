import type { Appraisal } from "../../../domain/dealer/Appraisal.js";
import {
  addMonths,
  Deal,
  DealRuleError,
  instalmentSchedule,
  needsApproval,
  planDates,
  planPosition,
  type ChecklistItem,
  type DealProps,
  type DealStatus,
  type DealTerms,
  type LoanStatus,
  type PlanFrequency,
  type PlanPosition,
} from "../../../domain/dealer/Deal.js";
import type { CommissionShare } from "../../../domain/dealer/Commission.js";
import type { AddOnKind, Financing, Quote } from "../../../domain/dealer/Quote.js";
import { StockUnit } from "../../../domain/dealer/StockUnit.js";
import { TRADE_IN_SOURCE, type PaymentMethod } from "../../../domain/finance/Payment.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { IInvoiceRepository } from "../../../domain/repositories/IFinanceRepositories.js";
import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import type { AuthorizationPolicy } from "../../authorization/AuthorizationPolicy.js";
import type { Principal } from "../../authorization/Principal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import {
  DEAL_SOURCE,
  type DealCustomer,
  type DealPayment,
  type IAppraisals,
  type IDeals,
} from "../../ports/IDealerDeals.js";
import type { ILeads, IQuotes } from "../../ports/IDealerSales.js";
import type { IDealerStock, StockRecord } from "../../ports/IDealerStock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IRecipientDirectory } from "../../ports/INotifications.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import { TenantCalendar } from "../../services/TenantCalendar.js";
import type { Documents } from "../documents/Documents.js";
import type { FileView, UploadStarted } from "../files/FileService.js";
import type { DocumentUploadInput, OwnedDocuments } from "../files/OwnedDocuments.js";
import type { Invoicing } from "../finance/Invoicing.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { PaymentRecording } from "../finance/PaymentRecording.js";
import type { DocumentNumbering } from "../reference/DocumentNumbering.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { VehicleRegistry } from "../vehicles/VehicleRegistry.js";
import { AppraisalNotFoundError } from "./Appraisals.js";
import type { CostOfSales } from "./CostOfSales.js";
import type { DealerCommissions } from "./DealerCommissions.js";
import { profitView, type DealProfit, type ProfitView } from "./DealProfit.js";
import { LeadNotFoundError, noteOnLead, reachesLead } from "./DealerLeads.js";
import { ADD_ON_WORDS, FINANCING_WORDS } from "./DealerQuotes.js";

export class DealNotFoundError extends ApplicationError {
  readonly code = "DEAL_NOT_FOUND";
  constructor() {
    super("Deal not found");
  }
}

/** Stock a deal is made on: ready or on sale (decision 445). */
const SELLABLE = new Set(["ready", "listed"]);
/** Discount a seller gives without approval when their role sets no max_percent (decision 446). */
export const DEFAULT_DISCOUNT_PERCENT = 5;
/** Days a reservation holds when none is given. */
export const DEFAULT_HOLD_DAYS = 7;
/** Days after delivery for the after-sale call. */
export const AFTER_SALE_DAYS = 7;
export const DEAL_PHOTO_OWNER = "dealer_deal";
const SUBJECT = "dealer_deal";
/** A sold vehicle is stock no longer (decision 451). */
const STOCK_STATUSES = new Set(["available", "for_sale"]);

/** Money as the counter takes it (amounts as decimal text, "250.00"). */
export type CounterMoney = Readonly<{
  amount: string;
  method: Exclude<PaymentMethod, "trade_in">;
  momoNetwork?: "mtn" | "telecel" | "at" | null;
  reference?: string | null;
  paidOn?: string;
}>;

export type DealInput = Readonly<{
  vehicleId?: string;
  customerId?: string;
  leadId?: string | null;
  quoteId?: string | null;
  salesExecutiveId?: string;
  /** Default: the asking price. */
  price?: string;
  discount?: string;
  addOns?: readonly Readonly<{ kind: AddOnKind; description?: string | null; amount: string }>[];
  tradeInId?: string | null;
  financing?: Financing;
  loan?: Readonly<{ lender: string; amount: string; reference?: string | null }> | null;
  plan?: Readonly<{
    downPayment: string;
    markupPercent: string;
    frequency: PlanFrequency;
    months: number;
    firstDueOn?: string | null;
  }> | null;
  warrantyMonths?: number;
  serviceVouchers?: number;
  notes?: string | null;
}>;

export type DealQuery = Readonly<{
  statuses?: readonly DealStatus[];
  customerId?: string;
  vehicleId?: string;
  leadId?: string;
  salesExecutiveId?: string;
  limit: number;
  beforeId?: string;
}>;

export type DealAccount = Readonly<{
  /** The sale's invoices with tax (nothing before the sale). */
  invoiced: MoneyJson;
  paid: MoneyJson;
  /** What the customer still owes: the invoices, or the deal before the sale. */
  balance: MoneyJson;
  /** Paid for the deal and not yet on an invoice (the deposit before the sale). */
  credit: MoneyJson;
  /** Due before the car leaves (after the sale). */
  dueBeforeDelivery: MoneyJson | null;
  payments: readonly (Omit<DealPayment, "amountMinor" | "unallocatedMinor"> &
    Readonly<{ amount: MoneyJson }>)[];
}>;

export type DealView = Omit<
  DealProps,
  | "priceMinor"
  | "discountMinor"
  | "addOns"
  | "tradeIn"
  | "loan"
  | "plan"
  | "planChargeMinor"
  | "costOfSaleMinor"
> &
  Readonly<{
    price: MoneyJson;
    discount: MoneyJson;
    addOns: readonly Readonly<{ kind: AddOnKind; description: string; amount: MoneyJson }>[];
    tradeIn: Readonly<{ appraisalId: string; value: MoneyJson }> | null;
    loan: Readonly<{ lender: string; amount: MoneyJson; reference: string | null }> | null;
    plan: Readonly<{
      downPayment: MoneyJson;
      markupPercent: string;
      frequency: PlanFrequency;
      months: number;
      firstDueOn: string | null;
      charge: MoneyJson | null;
    }> | null;
    customerName: string;
    totals: Readonly<{
      vehicle: MoneyJson;
      addOns: MoneyJson;
      total: MoneyJson;
      tradeIn: MoneyJson;
      balance: MoneyJson;
    }>;
    account?: DealAccount;
    instalments?:
      | (Omit<
          PlanPosition,
          | "instalments"
          | "scheduledMinor"
          | "paidMinor"
          | "outstandingMinor"
          | "overdueMinor"
          | "nextDue"
        > &
          Readonly<{
            scheduled: MoneyJson;
            paid: MoneyJson;
            outstanding: MoneyJson;
            overdue: MoneyJson;
            nextDue: Readonly<{ number: number; dueOn: string; outstanding: MoneyJson }> | null;
            lines: readonly Readonly<{
              number: number;
              dueOn: string;
              amount: MoneyJson;
              paid: MoneyJson;
              status: string;
            }>[];
          }>)
      | null;
    photos?: readonly FileView[];
    /** Gross profit on the unit once sold (with `dealer.stock.cost.view`). */
    profit?: ProfitView | null;
  }>;

type Deps = Readonly<{
  unitOfWork: IUnitOfWork;
  deals: IDeals;
  appraisals: IAppraisals;
  leads: ILeads;
  quotes: IQuotes;
  stock: IDealerStock;
  vehicles: IVehicleRepository;
  registry: VehicleRegistry;
  invoicing: Invoicing;
  invoices: IInvoiceRepository;
  payments: PaymentRecording;
  posting: LedgerPosting;
  documents: Documents;
  photos: OwnedDocuments;
  costOfSales: CostOfSales;
  commissions: DealerCommissions;
  profit: DealProfit;
  recipients: IRecipientDirectory;
  organisation: IOrganisationSettings;
  policy: AuthorizationPolicy;
  scope: BranchScope;
  numbering: DocumentNumbering;
  calendar: TenantCalendar;
  auditTrail: IAuditTrail;
  requestContext: IRequestContext;
  ids: IIdGenerator;
  clock: IClock;
}>;

/**
 * Vehicle sales (docs/10 §6–7): a deal on a stock vehicle drafted from a quote or afresh; held
 * for the customer with a deposit until a date; paid through finance (deposits, instalments, the
 * bank's loan) as payments the deal's invoices take; sold with its invoice, the trade-in taken
 * into stock, the in-house schedule and the sales agreement; delivered against a checklist with
 * the delivery note once what is due before delivery is paid (decisions 445–452).
 */
export class DealerDeals {
  constructor(private readonly deps: Deps) {}

  list(actor: Principal, query: DealQuery): Promise<DealView[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const own = actor.grantFor("dealer.deals.view")?.scope === "own";
      const deals = await deps.deals.list({
        ...query,
        branchIds: own ? "all" : deps.scope.branchesFor(actor, "dealer.deals.view"),
        ...(own ? { salesExecutiveId: actor.userId } : {}),
      });
      const base = await this.base();
      const views: DealView[] = [];
      for (const deal of deals) views.push(await this.summary(deal, base));
      return views;
    });
  }

  get(actor: Principal, id: string): Promise<DealView> {
    return this.deps.unitOfWork.run(async () => this.detail(await this.reach(actor, id), actor));
  }

  create(actor: Principal, input: DealInput): Promise<DealView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const quote =
        input.quoteId === undefined || input.quoteId === null
          ? null
          : await this.quote(actor, input.quoteId);
      const q = quote?.snapshot();
      const vehicleId = input.vehicleId ?? q?.vehicleId;
      if (vehicleId === undefined) throw new DealRuleError("Choose the vehicle");
      const record = await this.vehicle(actor, vehicleId);
      const branchId = record.vehicle.branchId;
      if ((await deps.deals.liveForVehicle(vehicleId)) !== null)
        throw new DealRuleError("The vehicle is on another open deal");
      const leadId = await this.lead(actor, input.leadId ?? q?.leadId ?? null);
      const id = deps.ids.next();
      const now = deps.clock.now();
      const terms = await this.terms(actor, id, branchId, record, {
        ...(quote === null ? {} : await this.fromQuote(quote)),
        ...withoutUndefined(input),
        vehicleId,
        leadId,
      });
      const deal = Deal.draft({
        ...terms,
        id,
        number: await deps.numbering.next("deal", now),
        branchId,
        leadId,
        quoteId: quote?.id ?? null,
        needsApproval: this.approvalNeeded(actor, record, terms),
        createdBy: actor.userId,
        now,
      });
      await deps.deals.insert(deal);
      await this.attachTradeIn(deal, null);
      if (leadId !== null)
        await noteOnLead(deps, leadId, {
          kind: "deal",
          note: `Deal ${deal.snapshot().number} opened for the ${record.vehicle.make} ${record.vehicle.model}`,
          details: { dealId: id, status: "draft" },
          userId: actor.userId,
          advanceTo: "negotiation",
        });
      await this.audit(actor, "deal.created", deal);
      return this.detail(deal, actor);
    });
  }

  revise(actor: Principal, id: string, input: DealInput): Promise<DealView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const deal = await this.reach(actor, id, true);
      const d = deal.snapshot();
      this.require(actor, "dealer.deals.create", d.branchId);
      const record = (await deps.stock.record(d.vehicleId))!;
      const previous = d.tradeIn?.appraisalId ?? null;
      const terms = await this.terms(actor, id, d.branchId, record, {
        ...(await this.fromDeal(d)),
        ...withoutUndefined(input),
        vehicleId: d.vehicleId,
        leadId: d.leadId,
      });
      deal.revise(terms, this.approvalNeeded(actor, record, terms), deps.clock.now());
      await deps.deals.update(deal);
      await this.attachTradeIn(deal, previous);
      await this.audit(actor, "deal.revised", deal);
      return this.detail(deal, actor);
    });
  }

  /** A price below the minimum or a discount over the seller's limit, approved. */
  approve(actor: Principal, id: string): Promise<DealView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const deal = await this.reach(actor, id, true);
      if (!deps.scope.can(actor, "dealer.deals.approve", deal.snapshot().branchId))
        throw new DealRuleError("Only those who approve sales approve this price");
      deal.approve(actor.userId, deps.clock.now());
      await deps.deals.update(deal);
      await this.audit(actor, "deal.approved", deal);
      return this.detail(deal, actor);
    });
  }

  /** A deposit or other payment for the deal, recorded in finance. */
  recordPayment(actor: Principal, id: string, money: CounterMoney): Promise<DealView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const deal = await this.reach(actor, id, true);
      const d = deal.snapshot();
      if (d.status === "cancelled")
        throw new DealRuleError("The deal is cancelled: record the money in finance");
      await this.pay(actor, deal, money, `Sale ${d.number}`, "dealer.deals.payments.record");
      await this.audit(actor, "deal.payment_recorded", deal, { amount: money.amount });
      return this.detail(deal, actor);
    });
  }

  /** Holds the vehicle once a deposit is in, until a date (default a week). */
  reserve(
    actor: Principal,
    id: string,
    input: Readonly<{ holdUntil?: string }>,
  ): Promise<DealView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const deal = await this.reach(actor, id, true);
      const d = deal.snapshot();
      this.require(actor, "dealer.deals.create", d.branchId);
      const today = await deps.calendar.today();
      const holdUntil = input.holdUntil ?? TenantCalendar.addDays(today, DEFAULT_HOLD_DAYS);
      if (d.status === "reserved") {
        deal.extendHold(holdUntil, today, deps.clock.now());
      } else {
        if (credit(await deps.deals.prepayments(id)) === 0)
          throw new DealRuleError("Take a deposit first: a vehicle is held against one");
        deal.reserve(holdUntil, today, deps.clock.now());
        const unit = (await deps.stock.lock(d.vehicleId))!;
        unit.reserve(deps.clock.now());
        await deps.stock.update(unit);
        await this.moveVehicle(
          actor,
          d.vehicleId,
          "reserved",
          `Reserved on deal ${d.number}`,
          d.id,
        );
      }
      await deps.deals.update(deal);
      await this.note(actor, deal, `Reserved until ${holdUntil}`, "reserved");
      await this.audit(actor, "deal.reserved", deal, { holdUntil });
      return this.detail(deal, actor);
    });
  }

  /** The bank's answer on the loan; disbursed records the bank's payment for the customer. */
  loan(
    actor: Principal,
    id: string,
    input: Readonly<{
      status: LoanStatus;
      reference?: string | null;
      disbursement?: Omit<CounterMoney, "amount"> & Readonly<{ amount?: string }>;
    }>,
  ): Promise<DealView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const deal = await this.reach(actor, id, true);
      const d = deal.snapshot();
      this.require(
        actor,
        input.status === "disbursed" ? "dealer.deals.payments.record" : "dealer.deals.create",
        d.branchId,
      );
      deal.loan(input.status, input.reference ?? null, deps.clock.now());
      await deps.deals.update(deal);
      if (input.status === "disbursed") {
        const loan = deal.snapshot().loan!;
        const base = await this.base();
        const pay = input.disbursement ?? { method: "bank_transfer" as const };
        await this.pay(
          actor,
          deal,
          {
            ...pay,
            amount: pay.amount ?? Money.ofMinor(loan.loanMinor, base).toDecimalString(),
            reference: pay.reference ?? loan.reference,
          },
          `Loan from ${loan.lender} for sale ${d.number}`,
          "dealer.deals.payments.record",
        );
      }
      await this.note(actor, deal, `Bank loan ${input.status}`, `loan_${input.status}`);
      await this.audit(actor, `deal.loan_${input.status}`, deal);
      return this.detail(deal, actor);
    });
  }

  /**
   * The sale: the invoice (vehicle and add-ons), the trade-in taken into stock at its value as a
   * payment in kind, the deal's payments applied, the in-house schedule with its charge invoice,
   * the vehicle sold, the lead won and the agreement issued for signature.
   */
  sell(actor: Principal, id: string): Promise<DealView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const deal = await this.reach(actor, id, true);
      const d = deal.snapshot();
      this.require(actor, "dealer.deals.create", d.branchId);
      deal.assertSellable();
      const unit = (await deps.stock.lock(d.vehicleId))!;
      if (!SELLABLE.has(unit.status) && unit.status !== "reserved")
        throw new DealRuleError(`The vehicle is ${unit.status}: it is not for sale`);
      const record = (await deps.stock.record(d.vehicleId))!;
      const v = record.vehicle;
      const today = await deps.calendar.today();
      const base = await this.base();
      const accounts = await deps.posting.accounts();
      const money = (minor: number) => Money.ofMinor(minor, base).toDecimalString();
      const dates = d.plan === null ? null : planDates(d.plan, today);
      const invoice = await deps.invoicing.issueFor(actor, {
        partyType: "customer",
        partyId: d.customerId,
        branchId: d.branchId,
        vehicleId: d.vehicleId,
        currency: base,
        issueDate: today,
        // In-house: the balance is paid by the schedule.
        dueDate: dates?.lastDueOn ?? today,
        notes: `Sale ${d.number}`,
        lines: [
          {
            description: `${v.make} ${v.model}${v.year === null ? "" : ` ${v.year}`} (${v.plateNumber ?? v.code})`,
            quantity: 1,
            unitPrice: money(d.priceMinor),
            discount: money(d.discountMinor),
            accountId: accounts("vehicle_sales"),
            vehicleId: d.vehicleId,
          },
          ...d.addOns.map((a) => ({
            description: a.description,
            quantity: 1,
            unitPrice: money(a.amountMinor),
            accountId: accounts("other_income"),
            vehicleId: d.vehicleId,
          })),
        ],
        source: { type: DEAL_SOURCE, id: d.id },
      });

      let tradeInPaymentId: string | null = null;
      if (d.tradeIn !== null)
        tradeInPaymentId = await this.takeIn(actor, deal, invoice.id, today, base);

      let chargeInvoiceId: string | null = null;
      let planChargeMinor: number | null = null;
      if (d.plan !== null) {
        const issued = (await deps.invoices.findById(invoice.id))!.snapshot();
        const financed = issued.totalMinor - (d.tradeIn?.valueMinor ?? 0) - d.plan.downPaymentMinor;
        const { chargeMinor, schedule } = instalmentSchedule(d.plan, financed, today);
        planChargeMinor = chargeMinor;
        if (chargeMinor > 0)
          chargeInvoiceId = (
            await deps.invoicing.issueFor(actor, {
              partyType: "customer",
              partyId: d.customerId,
              branchId: d.branchId,
              vehicleId: d.vehicleId,
              currency: base,
              issueDate: today,
              dueDate: dates!.lastDueOn,
              notes: `Instalment charge, sale ${d.number}`,
              lines: [
                {
                  description: `Instalment charge (${d.plan.markupPercent}% over ${d.plan.months} months)`,
                  quantity: 1,
                  unitPrice: money(chargeMinor),
                  taxCode: null,
                  accountId: accounts("instalment_charges"),
                  vehicleId: d.vehicleId,
                },
              ],
              source: { type: DEAL_SOURCE, id: d.id },
            })
          ).id;
        await deps.deals.saveSchedule(d.id, schedule);
      }

      const now = deps.clock.now();
      deal.sell(
        {
          soldOn: today,
          invoiceId: invoice.id,
          chargeInvoiceId,
          planChargeMinor,
          tradeInPaymentId,
        },
        now,
      );
      await this.settle(actor, deal);
      unit.sell(today, now);
      await deps.stock.update(unit);
      deal.costed(await deps.costOfSales.post(actor, deal.snapshot(), record, today), now);
      await this.moveVehicle(actor, d.vehicleId, "sold", `Sold on deal ${d.number}`, d.id);
      deal.agreementIssued(await this.agreement(actor, deal, record, invoice.number ?? ""), now);
      await deps.deals.update(deal);
      await this.win(actor, deal);
      await this.audit(actor, "deal.sold", deal, { invoiceId: invoice.id });
      return this.detail(deal, actor);
    });
  }

  /** The car leaves: once what is due before delivery is paid, against the checklist. */
  deliver(
    actor: Principal,
    id: string,
    input: Readonly<{ odometer: number; checklist: readonly ChecklistItem[] }>,
  ): Promise<DealView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const deal = await this.reach(actor, id, true);
      const d = deal.snapshot();
      this.require(actor, "dealer.deals.deliver", d.branchId);
      if (d.status !== "sold") throw new DealRuleError("Only a sold vehicle is delivered");
      const { invoicedMinor, paidMinor } = await this.invoiced(d);
      if (paidMinor < deal.dueBeforeDelivery(invoicedMinor))
        throw new DealRuleError(
          d.financing === "in_house"
            ? "The down payment is not paid in full yet"
            : "The sale is not paid in full yet",
        );
      const today = await deps.calendar.today();
      const record = (await deps.stock.record(d.vehicleId))!;
      const customer = (await deps.deals.customer(d.customerId))!;
      const warrantyEndsOn = d.warrantyMonths === 0 ? null : addMonths(today, d.warrantyMonths);
      const v = record.vehicle;
      const document = await deps.documents.issue(actor.userId, {
        type: "dealer_delivery_note",
        subject: { type: SUBJECT, id: d.id },
        branchId: d.branchId,
        data: {
          vehicle: vehicleData(v),
          buyer: { name: customer.name, phone: customer.phone },
          deal: { number: d.number },
          delivery: {
            deliveredOn: today,
            odometer: input.odometer,
            warrantyEndsOn,
            serviceVouchers: d.serviceVouchers,
          },
          checklist: input.checklist.map((c) => ({
            item: c.item,
            checked: c.checked,
            note: c.note,
          })),
        },
        signers: signers(actor, customer),
      });
      const now = deps.clock.now();
      deal.deliver(
        {
          on: today,
          odometer: input.odometer,
          checklist: input.checklist,
          documentId: document.id,
          invoicedMinor,
          paidMinor,
        },
        now,
      );
      await deps.deals.update(deal);
      const unit = (await deps.stock.lock(d.vehicleId))!;
      unit.deliver(today, now);
      await deps.stock.update(unit);
      await deps.commissions.accrue(actor, deal, today, paidMinor >= invoicedMinor);
      if (d.leadId !== null) {
        await deps.leads.saveTask({
          id: deps.ids.next(),
          leadId: d.leadId,
          title: "After-sale call: how is the vehicle?",
          dueOn: TenantCalendar.addDays(today, AFTER_SALE_DAYS),
          assignedTo: d.salesExecutiveId,
          doneAt: null,
          doneBy: null,
          createdBy: actor.userId,
          createdAt: now,
        });
        await this.note(actor, deal, `Delivered (odometer ${input.odometer})`, "delivered");
      }
      await this.audit(actor, "deal.delivered", deal);
      return this.detail(deal, actor);
    });
  }

  /** Called off before the sale: the vehicle back on sale; payments stay the customer's credit. */
  cancel(actor: Principal, id: string, reason: string): Promise<DealView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const deal = await this.reach(actor, id, true);
      const d = deal.snapshot();
      this.require(actor, "dealer.deals.create", d.branchId);
      const wasReserved = d.status === "reserved";
      deal.cancel(reason, deps.clock.now());
      await deps.deals.update(deal);
      if (wasReserved) await this.release(actor, d, `Deal ${d.number} cancelled`);
      if (d.tradeIn !== null) {
        const appraisal = await deps.appraisals.lock(d.tradeIn.appraisalId);
        appraisal?.detach(deps.clock.now());
        if (appraisal !== null) await deps.appraisals.update(appraisal);
      }
      await this.note(actor, deal, `Cancelled: ${deal.snapshot().cancelReason}`, "cancelled");
      await this.audit(actor, "deal.cancelled", deal, { reason });
      return this.detail(deal, actor);
    });
  }

  /** Who shares the commission (before delivery, when it accrues). */
  splitCommission(
    actor: Principal,
    id: string,
    split: readonly CommissionShare[],
  ): Promise<DealView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const deal = await this.reach(actor, id, true);
      const d = deal.snapshot();
      if (actor.grantFor("dealer.commissions.manage") === undefined)
        throw new DealRuleError("Only those who manage commissions split them");
      await deps.commissions.checkSplit(d.branchId, split);
      deal.splitCommission(split, deps.clock.now());
      await deps.deals.update(deal);
      await this.audit(actor, "deal.commission_split", deal, { split });
      return this.detail(deal, actor);
    });
  }

  startPhoto(actor: Principal, id: string, input: DocumentUploadInput): Promise<UploadStarted> {
    return this.deps.unitOfWork.run(async () => {
      await this.reach(actor, id);
      return this.deps.photos.start(id, input, actor.userId);
    });
  }

  completePhoto(actor: Principal, id: string, fileId: string): Promise<FileView> {
    return this.deps.unitOfWork.run(async () => {
      await this.reach(actor, id);
      return this.deps.photos.complete(id, fileId);
    });
  }

  // --- the daily job (inside its unit of work) ---

  /** Holds that ran out: the deal back to a draft, the vehicle back on sale. */
  async lapse(today: string): Promise<Deal[]> {
    const { deps } = this;
    const lapsed: Deal[] = [];
    for (const id of await deps.deals.lapsedReservations(today)) {
      const deal = await deps.deals.lock(id);
      if (deal === null) continue;
      const d = deal.snapshot();
      if (!deal.lapse(today, deps.clock.now())) continue;
      await deps.deals.update(deal);
      await this.release(null, d, `Hold on deal ${d.number} ran out`);
      if (d.leadId !== null)
        await noteOnLead(deps, d.leadId, {
          kind: "deal",
          note: `The hold on deal ${d.number} ran out on ${d.holdUntil}`,
          details: { dealId: d.id, status: "lapsed" },
          userId: null,
        });
      lapsed.push(deal);
    }
    return lapsed;
  }

  /** Where an in-house deal's instalments stand today. */
  async position(deal: Deal, today: string): Promise<PlanPosition | null> {
    const d = deal.snapshot();
    if (d.plan === null || d.invoiceId === null) return null;
    const schedule = await this.deps.deals.schedule(d.id);
    if (schedule.length === 0) return null;
    const { paidMinor } = await this.invoiced(d);
    return planPosition(schedule, paidMinor - deal.dueBeforeDelivery(0), today);
  }

  // --- helpers ---

  private async terms(
    actor: Principal,
    dealId: string,
    branchId: string,
    record: StockRecord,
    input: DealInput & Readonly<{ vehicleId: string; leadId: string | null }>,
  ): Promise<DealTerms> {
    const { deps } = this;
    const base = await this.base();
    const parse = (amount: string) => Money.parse(amount, base).amountMinor;
    const lead = input.leadId === null ? null : await deps.leads.get(input.leadId);
    const customerId = input.customerId ?? lead?.snapshot().customerId ?? null;
    if (customerId === null)
      throw new DealRuleError(
        "Register the buyer as a customer first: the sale is invoiced to them",
      );
    if ((await deps.deals.customer(customerId)) === null)
      throw new DealRuleError("The customer was not found");
    const salesExecutiveId = input.salesExecutiveId ?? lead?.snapshot().assignedTo ?? actor.userId;
    if (salesExecutiveId !== actor.userId) {
      const sellers = await deps.recipients.staffWith("dealer.deals.create", branchId);
      if (!sellers.some((s) => s.userId === salesExecutiveId))
        throw new DealRuleError("The sales executive must make sales in the vehicle's branch");
    }
    const asking = record.unit.snapshot().askingPriceMinor;
    if (input.price === undefined && asking === null)
      throw new DealRuleError("The vehicle has no asking price: give the price");
    const discountMinor = input.discount === undefined ? 0 : parse(input.discount);
    if (discountMinor > 0 && !deps.scope.can(actor, "dealer.deals.discount", branchId))
      throw new DealRuleError("You do not give discounts: ask someone who does");
    let tradeIn = null;
    if (input.tradeInId !== undefined && input.tradeInId !== null) {
      const appraisal = await this.appraisal(actor, input.tradeInId);
      appraisal.assertUsable(await deps.calendar.today(), dealId);
      tradeIn = { appraisalId: appraisal.id, valueMinor: appraisal.snapshot().valueMinor };
    }
    const financing = input.financing ?? "cash";
    return {
      vehicleId: input.vehicleId,
      customerId,
      salesExecutiveId,
      priceMinor: input.price === undefined ? asking! : parse(input.price),
      discountMinor,
      addOns: (input.addOns ?? []).map((a) => ({
        kind: a.kind,
        description: a.description?.trim() || ADD_ON_WORDS[a.kind],
        amountMinor: parse(a.amount),
      })),
      tradeIn,
      financing,
      loan:
        financing !== "bank" || input.loan === undefined || input.loan === null
          ? null
          : {
              lender: input.loan.lender,
              loanMinor: parse(input.loan.amount),
              reference: input.loan.reference ?? null,
            },
      plan:
        financing !== "in_house" || input.plan === undefined || input.plan === null
          ? null
          : {
              downPaymentMinor: parse(input.plan.downPayment),
              markupPercent: input.plan.markupPercent,
              frequency: input.plan.frequency,
              months: input.plan.months,
              firstDueOn: input.plan.firstDueOn ?? null,
            },
      warrantyMonths: input.warrantyMonths ?? 0,
      serviceVouchers: input.serviceVouchers ?? 0,
      notes: input.notes ?? null,
    };
  }

  private approvalNeeded(actor: Principal, record: StockRecord, terms: DealTerms): boolean {
    const limit =
      this.deps.policy.limit(actor, "dealer.deals.discount", "max_percent") ??
      DEFAULT_DISCOUNT_PERCENT;
    return needsApproval(terms, record.unit.snapshot().minimumPriceMinor, limit);
  }

  /** The appraisal moves with the deal's trade-in (attached, or freed when replaced). */
  private async attachTradeIn(deal: Deal, previous: string | null): Promise<void> {
    const { deps } = this;
    const current = deal.snapshot().tradeIn?.appraisalId ?? null;
    if (previous === current) return;
    const now = deps.clock.now();
    if (previous !== null) {
      const old = await deps.appraisals.lock(previous);
      old?.detach(now);
      if (old !== null) await deps.appraisals.update(old);
    }
    if (current !== null) {
      const appraisal = (await deps.appraisals.lock(current))!;
      appraisal.attach(deal.id, await deps.calendar.today(), now);
      await deps.appraisals.update(appraisal);
    }
  }

  /** The trade-in becomes a stock vehicle at its value, paid in kind towards the invoice. */
  private async takeIn(
    actor: Principal,
    deal: Deal,
    invoiceId: string,
    today: string,
    base: string,
  ): Promise<string> {
    const { deps } = this;
    const d = deal.snapshot();
    const appraisal = (await deps.appraisals.lock(d.tradeIn!.appraisalId))!;
    appraisal.assertUsable(today, d.id);
    const a = appraisal.snapshot();
    const prepared = await deps.registry.prepare(actor, {
      branchId: d.branchId,
      status: "reconditioning",
      make: a.make,
      model: a.model,
      year: a.year,
      vin: a.vin,
      colour: a.colour,
      plateNumber: a.plateNumber,
      usage: "stock",
      odometer: a.mileage,
      notes: `Traded in on sale ${d.number} (appraisal ${a.number})`,
    });
    prepared.vehicle.updateFinancials(
      {
        acquisitionDate: today,
        acquisitionCostMinor: a.valueMinor,
        residualValueMinor: null,
        depreciationMethod: "none",
        usefulLifeMonths: null,
      },
      deps.clock.now(),
    );
    await deps.registry.persist(actor, prepared, "manual");
    await deps.stock.insert(
      StockUnit.add({
        vehicleId: prepared.vehicle.id,
        source: "trade_in",
        status: "reconditioning",
        stockedOn: today,
        terms: {
          holdingCostPerDayMinor: 0,
          consignment: null,
          notes: `Trade-in on sale ${d.number}`,
        },
        createdBy: actor.userId,
        now: deps.clock.now(),
      }),
    );
    const value = Money.ofMinor(a.valueMinor, base).toDecimalString();
    const payment = await deps.payments.record(
      actor,
      {
        direction: "in",
        method: "trade_in",
        partyType: "customer",
        partyId: d.customerId,
        branchId: d.branchId,
        currency: base,
        amount: value,
        paidOn: today,
        reference: a.number,
        vehicleId: prepared.vehicle.id,
        notes: `Trade-in ${a.make} ${a.model} on sale ${d.number}`,
        allocations: [{ invoiceId, amount: value }],
        source: { type: TRADE_IN_SOURCE, id: d.id },
      },
      "dealer.deals.create",
    );
    appraisal.use(prepared.vehicle.id, deps.clock.now());
    await deps.appraisals.update(appraisal);
    return payment.id;
  }

  private async pay(
    actor: Principal,
    deal: Deal,
    money: CounterMoney,
    notes: string,
    permission: "dealer.deals.payments.record",
  ): Promise<void> {
    const d = deal.snapshot();
    this.require(actor, permission, d.branchId);
    await this.deps.payments.record(
      actor,
      {
        direction: "in",
        method: money.method,
        partyType: "customer",
        partyId: d.customerId,
        branchId: d.branchId,
        currency: await this.base(),
        amount: money.amount,
        ...(money.paidOn === undefined ? {} : { paidOn: money.paidOn }),
        reference: money.reference ?? null,
        momoNetwork: money.momoNetwork ?? null,
        vehicleId: d.vehicleId,
        notes,
        source: { type: DEAL_SOURCE, id: d.id },
      },
      permission,
    );
    if (d.invoiceId !== null) await this.settle(actor, deal);
  }

  /** The deal's payments not yet used pay its invoices: the sale first, then the charge. */
  private async settle(actor: Principal, deal: Deal): Promise<void> {
    const { deps } = this;
    const d = deal.snapshot();
    const open: { id: string; balanceMinor: number }[] = [];
    for (const invoiceId of [d.invoiceId, d.chargeInvoiceId]) {
      if (invoiceId === null) continue;
      const p = (await deps.invoices.findById(invoiceId))!.snapshot();
      if (p.status === "issued" || p.status === "partially_paid")
        open.push({ id: invoiceId, balanceMinor: p.totalMinor - p.paidMinor });
    }
    for (const prepayment of await deps.deals.prepayments(d.id)) {
      let left = prepayment.unallocatedMinor;
      for (const invoice of open) {
        const share = Math.min(left, invoice.balanceMinor);
        if (share <= 0) continue;
        await deps.payments.allocateFor(actor, prepayment.paymentId, invoice.id, share);
        invoice.balanceMinor -= share;
        left -= share;
      }
    }
  }

  private async invoiced(d: DealProps): Promise<{ invoicedMinor: number; paidMinor: number }> {
    let invoicedMinor = 0;
    let paidMinor = 0;
    for (const invoiceId of [d.invoiceId, d.chargeInvoiceId]) {
      if (invoiceId === null) continue;
      const p = (await this.deps.invoices.findById(invoiceId))!.snapshot();
      if (p.status === "void") continue;
      invoicedMinor += p.totalMinor;
      paidMinor += p.paidMinor;
    }
    return { invoicedMinor, paidMinor };
  }

  private async agreement(
    actor: Principal,
    deal: Deal,
    record: StockRecord,
    invoiceNumber: string,
  ): Promise<string> {
    const { deps } = this;
    const d = deal.snapshot();
    const base = await this.base();
    const money = (minor: number) => ({ amountMinor: minor, currency: base });
    const customer = (await deps.deals.customer(d.customerId))!;
    const { invoicedMinor } = await this.invoiced(d);
    const schedule = d.plan === null ? [] : await deps.deals.schedule(d.id);
    let tradeIn: string | null = null;
    if (d.tradeIn !== null) {
      const a = (await deps.appraisals.get(d.tradeIn.appraisalId))!.snapshot();
      tradeIn = `${a.make} ${a.model}${a.year === null ? "" : ` ${a.year}`}${a.plateNumber === null ? "" : `, ${a.plateNumber}`}`;
    }
    const document = await deps.documents.issue(actor.userId, {
      type: "dealer_sales_agreement",
      subject: { type: SUBJECT, id: d.id },
      branchId: d.branchId,
      data: {
        vehicle: { ...vehicleData(record.vehicle), odometer: record.vehicle.odometer },
        buyer: {
          name: customer.name,
          phone: customer.phone,
          address: customer.address,
          ghanaCardNumber: customer.ghanaCardNumber,
        },
        deal: {
          number: d.number,
          price: money(d.priceMinor),
          hasDiscount: d.discountMinor > 0,
          discount: money(d.discountMinor),
          invoiceNumber,
          invoiced: money(invoicedMinor),
          tradeIn,
          tradeInValue: money(d.tradeIn?.valueMinor ?? 0),
          financing: FINANCING_WORDS[d.financing],
          lender: d.loan?.lender ?? null,
          loan: d.loan === null ? null : money(d.loan.loanMinor),
          hasPlan: schedule.length > 0,
          downPayment: money(d.plan?.downPaymentMinor ?? 0),
          instalments: schedule.length,
          instalment: money(schedule[0]?.amountMinor ?? 0),
          firstDueOn: schedule[0]?.dueOn ?? null,
          lastDueOn: schedule.at(-1)?.dueOn ?? null,
          planCharge: money(d.planChargeMinor ?? 0),
          warrantyMonths: d.warrantyMonths,
          serviceVouchers: d.serviceVouchers,
          notes: d.notes,
        },
        addOns: d.addOns.map((a) => ({ description: a.description, amount: money(a.amountMinor) })),
      },
      signers: signers(actor, customer),
    });
    return document.id;
  }

  /** The lead is won by the sale. */
  private async win(actor: Principal, deal: Deal): Promise<void> {
    const { deps } = this;
    const d = deal.snapshot();
    if (d.leadId === null) return;
    const lead = await deps.leads.lock(d.leadId);
    if (lead !== null && lead.isOpen) {
      const now = deps.clock.now();
      const from = lead.moveTo("won", null, now);
      await deps.leads.update(lead);
      await deps.leads.addActivity({
        id: deps.ids.next(),
        leadId: lead.id,
        kind: "stage",
        note: null,
        details: { from, to: "won" },
        occurredAt: now,
        recordedBy: actor.userId,
        recordedAt: now,
      });
    }
    await this.note(actor, deal, "Sold", "sold");
  }

  /** The vehicle is no longer held: its stock unit and the vehicle back on sale. */
  private async release(actor: Principal | null, d: DealProps, reason: string): Promise<void> {
    const { deps } = this;
    const unit = await deps.stock.lock(d.vehicleId);
    if (unit === null || unit.status !== "reserved") return;
    unit.release(deps.clock.now());
    await deps.stock.update(unit);
    const vehicle = await deps.vehicles.findById(d.vehicleId);
    if (vehicle === null || vehicle.status !== "reserved") return;
    const userId = actor?.userId ?? d.salesExecutiveId;
    const ref = { type: SUBJECT, id: d.id };
    await deps.registry.moveByModule(vehicle, "for_sale", { ref, reason, userId });
    if (unit.snapshot().status === "ready")
      await deps.registry.moveByModule(vehicle, "available", { ref, reason, userId });
  }

  /** Reserved and sold go through "for sale" when the vehicle was only ready. */
  private async moveVehicle(
    actor: Principal,
    vehicleId: string,
    to: "reserved" | "sold",
    reason: string,
    dealId: string,
  ): Promise<void> {
    const { deps } = this;
    const vehicle = await deps.vehicles.findById(vehicleId);
    if (vehicle === null || vehicle.status === to) return;
    const ref = { type: SUBJECT, id: dealId };
    if (STOCK_STATUSES.has(vehicle.status) && vehicle.status !== "for_sale")
      await deps.registry.moveByModule(vehicle, "for_sale", { ref, reason, userId: actor.userId });
    await deps.registry.moveByModule(vehicle, to, { ref, reason, userId: actor.userId });
  }

  private async note(actor: Principal, deal: Deal, note: string, status: string): Promise<void> {
    const d = deal.snapshot();
    if (d.leadId === null) return;
    await noteOnLead(this.deps, d.leadId, {
      kind: "deal",
      note: `Deal ${d.number}: ${note}`,
      details: { dealId: d.id, status },
      userId: actor.userId,
    });
  }

  private async vehicle(actor: Principal, vehicleId: string): Promise<StockRecord> {
    const record = await this.deps.stock.record(vehicleId);
    if (
      record === null ||
      !this.deps.scope.can(actor, "dealer.deals.create", record.vehicle.branchId)
    )
      throw new DealRuleError("The vehicle is not in your stock");
    if (!SELLABLE.has(record.unit.status))
      throw new DealRuleError(`The vehicle is ${record.unit.status}: it is not for sale`);
    return record;
  }

  private async quote(actor: Principal, quoteId: string): Promise<Quote> {
    const quote = await this.deps.quotes.get(quoteId);
    const q = quote?.snapshot();
    if (q === undefined || !this.deps.scope.can(actor, "dealer.quotes.manage", q.branchId))
      throw new DealRuleError("The quote was not found");
    if (q.status !== "sent" && q.status !== "accepted")
      throw new DealRuleError("Make a deal from a sent or accepted quote");
    return quote!;
  }

  /** What the deal says now, as the input that would say it. */
  private async fromDeal(d: DealProps): Promise<DealInput> {
    const base = await this.base();
    const money = (minor: number) => Money.ofMinor(minor, base).toDecimalString();
    return {
      customerId: d.customerId,
      salesExecutiveId: d.salesExecutiveId,
      price: money(d.priceMinor),
      discount: money(d.discountMinor),
      addOns: d.addOns.map((a) => ({
        kind: a.kind,
        description: a.description,
        amount: money(a.amountMinor),
      })),
      tradeInId: d.tradeIn?.appraisalId ?? null,
      financing: d.financing,
      loan:
        d.loan === null
          ? null
          : { lender: d.loan.lender, amount: money(d.loan.loanMinor), reference: d.loan.reference },
      plan:
        d.plan === null
          ? null
          : {
              downPayment: money(d.plan.downPaymentMinor),
              markupPercent: d.plan.markupPercent,
              frequency: d.plan.frequency,
              months: d.plan.months,
              firstDueOn: d.plan.firstDueOn,
            },
      warrantyMonths: d.warrantyMonths,
      serviceVouchers: d.serviceVouchers,
      notes: d.notes,
    };
  }

  /** The quote's price, discount, add-ons, customer and financing carry into the deal. */
  private async fromQuote(quote: Quote): Promise<DealInput> {
    const q = quote.snapshot();
    const base = await this.base();
    const money = (minor: number) => Money.ofMinor(minor, base).toDecimalString();
    return {
      price: money(q.priceMinor),
      discount: money(q.discountMinor),
      addOns: q.addOns.map((a) => ({
        kind: a.kind,
        description: a.description,
        amount: money(a.amountMinor),
      })),
      financing: q.financing,
      ...(q.customerId === null ? {} : { customerId: q.customerId }),
    };
  }

  private async lead(actor: Principal, leadId: string | null): Promise<string | null> {
    if (leadId === null) return null;
    const lead = await this.deps.leads.get(leadId);
    if (lead === null || !reachesLead(actor, this.deps.scope, "dealer.leads.view", lead))
      throw new LeadNotFoundError();
    return lead.id;
  }

  private async appraisal(actor: Principal, id: string): Promise<Appraisal> {
    const appraisal = await this.deps.appraisals.get(id);
    if (
      appraisal === null ||
      !this.deps.scope.can(actor, "dealer.appraisals.manage", appraisal.snapshot().branchId)
    )
      throw new AppraisalNotFoundError();
    return appraisal;
  }

  private async reach(actor: Principal, id: string, lock = false): Promise<Deal> {
    const { deps } = this;
    const deal = lock ? await deps.deals.lock(id) : await deps.deals.get(id);
    if (deal === null) throw new DealNotFoundError();
    const d = deal.snapshot();
    const grant = actor.grantFor("dealer.deals.view");
    const seen =
      grant?.scope === "own"
        ? d.salesExecutiveId === actor.userId
        : deps.scope.can(actor, "dealer.deals.view", d.branchId);
    if (!seen) throw new DealNotFoundError();
    return deal;
  }

  private require(
    actor: Principal,
    permission: "dealer.deals.create" | "dealer.deals.deliver" | "dealer.deals.payments.record",
    branchId: string,
  ): void {
    if (!this.deps.scope.can(actor, permission, branchId))
      throw new DealRuleError(
        permission === "dealer.deals.deliver"
          ? "You do not hand vehicles over"
          : permission === "dealer.deals.payments.record"
            ? "You do not record payments on sales"
            : "You do not make sales there",
      );
  }

  private async base(): Promise<string> {
    return (await this.deps.organisation.currencySettings()).baseCurrency;
  }

  private async summary(deal: Deal, base: string): Promise<DealView> {
    const customer = await this.deps.deals.customer(deal.snapshot().customerId);
    return view(deal, base, customer?.name ?? "");
  }

  private async detail(deal: Deal, actor: Principal): Promise<DealView> {
    const { deps } = this;
    const d = deal.snapshot();
    const base = await this.base();
    const m = (minor: number) => Money.ofMinor(minor, base).toJSON();
    const payments = await deps.deals.payments(d.id);
    const creditMinor = credit(await deps.deals.prepayments(d.id));
    const sold = d.invoiceId !== null;
    const { invoicedMinor, paidMinor } = await this.invoiced(d);
    const today = await deps.calendar.today();
    const position = await this.position(deal, today);
    const customer = await deps.deals.customer(d.customerId);
    return {
      ...view(deal, base, customer?.name ?? ""),
      account: {
        invoiced: m(invoicedMinor),
        paid: m(
          sold
            ? paidMinor
            : payments
                .filter((p) => p.status === "recorded")
                .reduce((s, p) => s + p.amountMinor, 0),
        ),
        balance: m(sold ? invoicedMinor - paidMinor : deal.totals().balanceMinor - creditMinor),
        credit: m(creditMinor),
        dueBeforeDelivery: sold
          ? m(Math.max(0, deal.dueBeforeDelivery(invoicedMinor) - paidMinor))
          : null,
        payments: payments.map(({ amountMinor, unallocatedMinor: _u, ...p }) => ({
          ...p,
          amount: m(amountMinor),
        })),
      },
      instalments:
        position === null
          ? null
          : {
              overdueCount: position.overdueCount,
              scheduled: m(position.scheduledMinor),
              paid: m(position.paidMinor),
              outstanding: m(position.outstandingMinor),
              overdue: m(position.overdueMinor),
              nextDue:
                position.nextDue === null
                  ? null
                  : {
                      number: position.nextDue.number,
                      dueOn: position.nextDue.dueOn,
                      outstanding: m(position.nextDue.outstandingMinor),
                    },
              lines: position.instalments.map((i) => ({
                number: i.number,
                dueOn: i.dueOn,
                amount: m(i.amountMinor),
                paid: m(i.paidMinor),
                status: i.status,
              })),
            },
      photos: await deps.photos.list(d.id),
      ...(deps.scope.can(actor, "dealer.stock.cost.view", d.branchId)
        ? { profit: await this.profitOf(d, base) }
        : {}),
    };
  }

  private async profitOf(d: DealProps, base: string): Promise<ProfitView | null> {
    const profit = await this.deps.profit.of(d);
    return profit === null ? null : profitView(profit, base);
  }

  private async audit(
    actor: Principal,
    action: string,
    deal: Deal,
    metadata?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const d = deal.snapshot();
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: SUBJECT,
      entityId: deal.id,
      after: {
        number: d.number,
        status: d.status,
        vehicleId: d.vehicleId,
        customerId: d.customerId,
        totalMinor: deal.totals().totalMinor,
      },
      ...(metadata === undefined ? {} : { metadata }),
    });
  }
}

const credit = (prepayments: readonly { unallocatedMinor: number }[]) =>
  prepayments.reduce((s, p) => s + p.unallocatedMinor, 0);

function withoutUndefined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function vehicleData(v: StockRecord["vehicle"]) {
  return {
    code: v.code,
    plateNumber: v.plateNumber,
    make: v.make,
    model: v.model,
    year: v.year,
    colour: v.colour,
    vin: v.vin,
    engineNumber: null,
  };
}

/** The seller and the buyer sign in the system when the buyer can be reached; else on paper. */
function signers(actor: Principal, customer: DealCustomer) {
  if (customer.phone === null && customer.email === null) return undefined;
  return [
    { role: "business", party: { type: "user" as const, id: actor.userId } },
    {
      role: "buyer",
      party: {
        type: "guest" as const,
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
      },
    },
  ];
}

export function view(deal: Deal, base: string, customerName: string): DealView {
  const {
    priceMinor,
    discountMinor,
    addOns,
    tradeIn,
    loan,
    plan,
    planChargeMinor,
    costOfSaleMinor: _cost,
    ...rest
  } = deal.snapshot();
  const m = (minor: number) => Money.ofMinor(minor, base).toJSON();
  const t = deal.totals();
  return {
    ...rest,
    customerName,
    price: m(priceMinor),
    discount: m(discountMinor),
    addOns: addOns.map((a) => ({
      kind: a.kind,
      description: a.description,
      amount: m(a.amountMinor),
    })),
    tradeIn:
      tradeIn === null ? null : { appraisalId: tradeIn.appraisalId, value: m(tradeIn.valueMinor) },
    loan:
      loan === null
        ? null
        : { lender: loan.lender, amount: m(loan.loanMinor), reference: loan.reference },
    plan:
      plan === null
        ? null
        : {
            downPayment: m(plan.downPaymentMinor),
            markupPercent: plan.markupPercent,
            frequency: plan.frequency,
            months: plan.months,
            firstDueOn: plan.firstDueOn,
            charge: planChargeMinor === null ? null : m(planChargeMinor),
          },
    totals: {
      vehicle: m(t.vehicleMinor),
      addOns: m(t.addOnsMinor),
      total: m(t.totalMinor),
      tradeIn: m(t.tradeInMinor),
      balance: m(t.balanceMinor),
    },
  };
}
