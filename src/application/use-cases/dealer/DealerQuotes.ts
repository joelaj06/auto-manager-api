import {
  Quote,
  QuoteRuleError,
  type AddOnKind,
  type Financing,
  type QuoteProps,
  type QuoteStatus,
  type QuoteTerms,
} from "../../../domain/dealer/Quote.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { Principal } from "../../authorization/Principal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { ILeads, IQuotes } from "../../ports/IDealerSales.js";
import type { IDealerStock, StockRecord } from "../../ports/IDealerStock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { Documents } from "../documents/Documents.js";
import type { DocumentNumbering } from "../reference/DocumentNumbering.js";
import { recordUserAction } from "../reference/userAudit.js";
import { LeadNotFoundError, noteOnLead, reachesLead } from "./DealerLeads.js";

export class QuoteNotFoundError extends ApplicationError {
  readonly code = "SALES_QUOTE_NOT_FOUND";
  constructor() {
    super("Quote not found");
  }
}

/** Stock that is quoted: ready or on sale (decision 442). */
const QUOTABLE = new Set(["ready", "listed"]);
/** Days a quote holds when none is given. */
export const DEFAULT_QUOTE_DAYS = 14;
const SUBJECT = "dealer_quote";
const FINANCING_WORDS: Readonly<Record<Financing, string>> = {
  cash: "Cash",
  bank: "Bank loan",
  in_house: "Instalments with the dealer",
};

export type QuoteInput = Readonly<{
  vehicleId: string;
  leadId?: string | null;
  customerId?: string | null;
  customerName?: string | null;
  /** Default: the asking price. */
  price?: string;
  discount?: string;
  addOns?: readonly Readonly<{ kind: AddOnKind; description?: string | null; amount: string }>[];
  tradeIn?: Readonly<{ description: string; value: string }> | null;
  financing?: Financing;
  deposit?: string | null;
  termMonths?: number | null;
  financingNote?: string | null;
  /** Default: today plus 14 days. */
  validUntil?: string;
  notes?: string | null;
}>;

export type QuoteQuery = Readonly<{
  leadId?: string;
  vehicleId?: string;
  customerId?: string;
  statuses?: readonly QuoteStatus[];
  limit: number;
  beforeId?: string;
}>;

export type QuoteView = Omit<
  QuoteProps,
  "priceMinor" | "discountMinor" | "addOns" | "tradeInMinor" | "depositMinor"
> &
  Readonly<{
    price: MoneyJson;
    discount: MoneyJson;
    addOns: readonly Readonly<{ kind: AddOnKind; description: string; amount: MoneyJson }>[];
    tradeIn: MoneyJson;
    deposit: MoneyJson | null;
    totals: Readonly<{
      vehicle: MoneyJson;
      addOns: MoneyJson;
      total: MoneyJson;
      balance: MoneyJson;
    }>;
  }>;

const ADD_ON_WORDS: Readonly<Record<AddOnKind, string>> = {
  registration: "Registration and number plates",
  tint: "Window tint",
  tracker: "Tracker",
  warranty: "Warranty",
  insurance: "Insurance",
  service_plan: "Service plan",
  other: "Other",
};

/**
 * Sales quotes (docs/10 §6): a stock vehicle at its asking price or another, a discount, add-ons,
 * a trade-in and a financing option, valid until a date; a price below the minimum is approved
 * by someone who sets prices before it is sent; sending issues the quotation PDF and logs it on
 * the lead; the customer's answer is recorded and sent quotes lapse after their date (decisions
 * 437–444).
 */
export class DealerQuotes {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      quotes: IQuotes;
      leads: ILeads;
      stock: IDealerStock;
      documents: Documents;
      organisation: IOrganisationSettings;
      scope: BranchScope;
      numbering: DocumentNumbering;
      calendar: TenantCalendar;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  list(actor: Principal, query: QuoteQuery): Promise<QuoteView[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const base = await this.base();
      return (
        await deps.quotes.list({
          ...query,
          branchIds: deps.scope.branchesFor(actor, "dealer.quotes.manage"),
        })
      ).map((q) => view(q, base));
    });
  }

  get(actor: Principal, id: string): Promise<QuoteView> {
    return this.deps.unitOfWork.run(async () =>
      view(await this.reach(actor, id), await this.base()),
    );
  }

  create(actor: Principal, input: QuoteInput): Promise<QuoteView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const record = await this.vehicle(actor, input.vehicleId);
      const base = await this.base();
      const today = await deps.calendar.today();
      const leadId = await this.lead(actor, input.leadId ?? null);
      const now = deps.clock.now();
      const quote = Quote.draft({
        ...(await this.terms(input, record, base, today, leadId)),
        id: deps.ids.next(),
        number: await deps.numbering.next("quote", now),
        branchId: record.vehicle.branchId,
        leadId,
        minimumPriceMinor: record.unit.snapshot().minimumPriceMinor,
        today,
        createdBy: actor.userId,
        now,
      });
      await deps.quotes.insert(quote);
      await this.audit(actor, "quote.created", quote);
      return view(quote, base);
    });
  }

  revise(actor: Principal, id: string, input: QuoteInput): Promise<QuoteView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const quote = await this.reach(actor, id, true);
      const record = await this.vehicle(actor, input.vehicleId);
      const base = await this.base();
      const today = await deps.calendar.today();
      const leadId =
        input.leadId === undefined ? quote.snapshot().leadId : await this.lead(actor, input.leadId);
      if (record.vehicle.branchId !== quote.snapshot().branchId)
        throw new QuoteRuleError("Quote a vehicle of the same branch, or start a new quote");
      quote.revise(
        await this.terms(input, record, base, today, leadId),
        record.unit.snapshot().minimumPriceMinor,
        today,
        deps.clock.now(),
      );
      await deps.quotes.update(quote);
      await this.audit(actor, "quote.revised", quote);
      return view(quote, base);
    });
  }

  /** A price below the minimum, approved by someone who sets prices. */
  approve(actor: Principal, id: string): Promise<QuoteView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const quote = await this.reach(actor, id, true);
      if (!deps.scope.can(actor, "dealer.stock.price.manage", quote.snapshot().branchId))
        throw new QuoteRuleError("Only those who set prices approve a price below the minimum");
      quote.approve(actor.userId, deps.clock.now());
      await deps.quotes.update(quote);
      await this.audit(actor, "quote.approved", quote);
      return view(quote, await this.base());
    });
  }

  /** Issues the quotation PDF; the lead is told and moves to negotiation. */
  send(actor: Principal, id: string): Promise<QuoteView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const quote = await this.reach(actor, id, true);
      const today = await deps.calendar.today();
      quote.assertSendable(today);
      const q = quote.snapshot();
      const record = await deps.stock.record(q.vehicleId);
      if (record === null || !QUOTABLE.has(record.unit.status))
        throw new QuoteRuleError("The vehicle is no longer for sale");
      const base = await this.base();
      const totals = quote.totals();
      const money = (minor: number) => ({ amountMinor: minor, currency: base });
      const v = record.vehicle;
      const phone =
        q.customerId !== null
          ? ((await deps.leads.customer(q.customerId))?.phone ?? null)
          : q.leadId !== null
            ? ((await deps.leads.get(q.leadId))?.snapshot().phone ?? null)
            : null;
      const document = await deps.documents.issue(actor.userId, {
        type: "dealer_quote",
        subject: { type: SUBJECT, id: quote.id },
        branchId: q.branchId,
        data: {
          vehicle: {
            code: v.code,
            plateNumber: v.plateNumber,
            make: v.make,
            model: v.model,
            year: v.year,
            colour: v.colour,
            vin: v.vin,
            engineNumber: null,
            odometer: v.odometer,
          },
          customer: { name: q.customerName, phone },
          quote: {
            number: q.number,
            validUntil: q.validUntil,
            currency: base,
            price: money(q.priceMinor),
            hasDiscount: q.discountMinor > 0,
            discount: money(q.discountMinor),
            total: money(totals.totalMinor),
            tradeIn: q.tradeInDescription,
            tradeInValue: money(q.tradeInMinor),
            balance: money(totals.balanceMinor),
            financing: FINANCING_WORDS[q.financing],
            deposit: q.depositMinor === null ? null : money(q.depositMinor),
            termMonths: q.termMonths,
            financingNote: q.financingNote,
            notes: q.notes,
          },
          addOns: q.addOns.map((a) => ({
            description: a.description,
            amount: money(a.amountMinor),
          })),
        },
      });
      quote.send(document.id, today, deps.clock.now());
      await deps.quotes.update(quote);
      if (q.leadId !== null)
        await noteOnLead(deps, q.leadId, {
          kind: "quote",
          note: `Quote ${q.number} sent: ${Money.ofMinor(totals.totalMinor, base).toJSON().formatted} for the ${v.make} ${v.model}`,
          details: { quoteId: quote.id, status: "sent", documentId: document.id },
          userId: actor.userId,
          advanceTo: "negotiation",
        });
      await this.audit(actor, "quote.sent", quote);
      return view(quote, base);
    });
  }

  /** The customer's answer, or the quote taken back. */
  decide(
    actor: Principal,
    id: string,
    input: Readonly<{ outcome: "accepted" | "rejected" | "withdrawn"; note?: string | null }>,
  ): Promise<QuoteView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const quote = await this.reach(actor, id, true);
      const now = deps.clock.now();
      quote.decide(input.outcome, input.note ?? null, await deps.calendar.today(), now);
      await deps.quotes.update(quote);
      const q = quote.snapshot();
      if (q.documentId !== null && input.outcome === "withdrawn")
        await deps.documents.voidFor(actor.userId, q.documentId, "Quote withdrawn");
      if (q.leadId !== null)
        await noteOnLead(deps, q.leadId, {
          kind: "quote",
          note: `Quote ${q.number} ${input.outcome}${q.decisionNote === null ? "" : `: ${q.decisionNote}`}`,
          details: { quoteId: quote.id, status: input.outcome },
          userId: actor.userId,
        });
      await this.audit(actor, `quote.${input.outcome}`, quote);
      return view(quote, await this.base());
    });
  }

  /** Sent quotes past their date lapse (the daily job); how many. */
  async expire(today: string): Promise<number> {
    const { deps } = this;
    let count = 0;
    for (const id of await deps.quotes.lapsed(today)) {
      const quote = await deps.quotes.lock(id);
      if (quote === null || !quote.expire(today, deps.clock.now())) continue;
      await deps.quotes.update(quote);
      count += 1;
      const q = quote.snapshot();
      if (q.leadId !== null)
        await noteOnLead(deps, q.leadId, {
          kind: "quote",
          note: `Quote ${q.number} lapsed on ${q.validUntil}`,
          details: { quoteId: quote.id, status: "expired" },
          userId: null,
        });
    }
    return count;
  }

  private async vehicle(actor: Principal, vehicleId: string): Promise<StockRecord> {
    const record = await this.deps.stock.record(vehicleId);
    if (
      record === null ||
      !this.deps.scope.can(actor, "dealer.quotes.manage", record.vehicle.branchId)
    )
      throw new QuoteRuleError("The vehicle is not in your stock");
    if (!QUOTABLE.has(record.unit.status))
      throw new QuoteRuleError(`The vehicle is ${record.unit.status}: it is not quoted`);
    return record;
  }

  private async lead(actor: Principal, leadId: string | null): Promise<string | null> {
    if (leadId === null) return null;
    const lead = await this.deps.leads.get(leadId);
    if (lead === null || !reachesLead(actor, this.deps.scope, "dealer.leads.view", lead))
      throw new LeadNotFoundError();
    return lead.id;
  }

  private async terms(
    input: QuoteInput,
    record: StockRecord,
    base: string,
    today: string,
    leadId: string | null,
  ): Promise<QuoteTerms> {
    const { deps } = this;
    const parse = (amount: string) => Money.parse(amount, base).amountMinor;
    const asking = record.unit.snapshot().askingPriceMinor;
    if (input.price === undefined && asking === null)
      throw new QuoteRuleError("The vehicle has no asking price: give the price");
    let customerName = input.customerName?.trim() || null;
    if (input.customerId !== undefined && input.customerId !== null) {
      const customer = await deps.leads.customer(input.customerId);
      if (customer === null) throw new QuoteRuleError("The customer was not found");
      customerName ??= customer.name;
    }
    if (customerName === null && leadId !== null)
      customerName = (await deps.leads.get(leadId))!.snapshot().name;
    if (customerName === null) throw new QuoteRuleError("Give the customer's name");
    return {
      vehicleId: input.vehicleId,
      customerId: input.customerId ?? null,
      customerName,
      priceMinor: input.price === undefined ? asking! : parse(input.price),
      discountMinor: input.discount === undefined ? 0 : parse(input.discount),
      addOns: (input.addOns ?? []).map((a) => ({
        kind: a.kind,
        description: a.description?.trim() || ADD_ON_WORDS[a.kind],
        amountMinor: parse(a.amount),
      })),
      tradeInDescription: input.tradeIn?.description ?? null,
      tradeInMinor:
        input.tradeIn === undefined || input.tradeIn === null ? 0 : parse(input.tradeIn.value),
      financing: input.financing ?? "cash",
      depositMinor:
        input.deposit === undefined || input.deposit === null ? null : parse(input.deposit),
      termMonths: input.termMonths ?? null,
      financingNote: input.financingNote ?? null,
      validUntil: input.validUntil ?? shift(today, DEFAULT_QUOTE_DAYS),
      notes: input.notes ?? null,
    };
  }

  private async reach(actor: Principal, id: string, lock = false): Promise<Quote> {
    const { deps } = this;
    const quote = lock ? await deps.quotes.lock(id) : await deps.quotes.get(id);
    if (quote === null || !deps.scope.can(actor, "dealer.quotes.manage", quote.snapshot().branchId))
      throw new QuoteNotFoundError();
    return quote;
  }

  private async base(): Promise<string> {
    return (await this.deps.organisation.currencySettings()).baseCurrency;
  }

  private async audit(actor: Principal, action: string, quote: Quote): Promise<void> {
    const q = quote.snapshot();
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: SUBJECT,
      entityId: quote.id,
      after: {
        number: q.number,
        status: q.status,
        vehicleId: q.vehicleId,
        totalMinor: quote.totals().totalMinor,
      },
    });
  }
}

function view(quote: Quote, base: string): QuoteView {
  const { priceMinor, discountMinor, addOns, tradeInMinor, depositMinor, ...q } = quote.snapshot();
  const m = (minor: number) => Money.ofMinor(minor, base).toJSON();
  const t = quote.totals();
  return {
    ...q,
    price: m(priceMinor),
    discount: m(discountMinor),
    addOns: addOns.map((a) => ({
      kind: a.kind,
      description: a.description,
      amount: m(a.amountMinor),
    })),
    tradeIn: m(tradeInMinor),
    deposit: depositMinor === null ? null : m(depositMinor),
    totals: {
      vehicle: m(t.vehicleMinor),
      addOns: m(t.addOnsMinor),
      total: m(t.totalMinor),
      balance: m(t.balanceMinor),
    },
  };
}

function shift(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
