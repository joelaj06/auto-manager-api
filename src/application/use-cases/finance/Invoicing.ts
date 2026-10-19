import {
  Invoice,
  type InvoiceLineInput,
  type InvoiceProps,
} from "../../../domain/finance/Invoice.js";
import { FinanceRuleError } from "../../../domain/finance/Journal.js";
import { Postings } from "../../../domain/finance/Postings.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { IInvoiceRepository } from "../../../domain/repositories/IFinanceRepositories.js";
import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import { TaxCode } from "../../../domain/tax/TaxCode.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import type { Page } from "../../dto/Page.js";
import { InvoiceNotFoundError } from "../../errors/FinanceErrors.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type {
  IFinanceQueries,
  IFinanceSettingsStore,
  ILedger,
  InvoiceListFilter,
} from "../../ports/IFinanceRecords.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { ITenantReferenceData } from "../../ports/IReferenceData.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import { PageCursor } from "../../services/PageCursor.js";
import { TenantCalendar } from "../../services/TenantCalendar.js";
import type { DocumentNumbering } from "../reference/DocumentNumbering.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { FinanceContext } from "./FinanceContext.js";
import type { LedgerPosting } from "./LedgerPosting.js";

/** Line as sent by clients: amounts as decimal strings in the invoice currency. */
export type InvoiceLineRequest = Readonly<{
  description: string;
  quantity: number;
  unitPrice: string;
  discount?: string;
  /** Omitted: the business's default sales tax code; null: no tax. */
  taxCode?: string | null;
  accountId?: string;
  vehicleId?: string | null;
}>;

export type InvoiceRequest = Readonly<{
  partyType: "customer" | "driver";
  partyId: string;
  branchId?: string;
  vehicleId?: string | null;
  issueDate?: string;
  dueDate?: string;
  currency?: string;
  fxRate?: string | null;
  notes?: string | null;
  lines: readonly InvoiceLineRequest[];
}>;

export type InvoiceView = Omit<
  InvoiceProps,
  "subtotalMinor" | "taxMinor" | "totalMinor" | "paidMinor" | "totalBaseMinor" | "lines"
> &
  Readonly<{
    subtotal: MoneyJson;
    tax: MoneyJson;
    total: MoneyJson;
    paid: MoneyJson;
    balance: MoneyJson;
    /** Tax per component across the lines (the breakdown a tax invoice shows). */
    taxBreakdown: readonly Readonly<{
      key: string;
      name: string;
      rate: string;
      amount: MoneyJson;
    }>[];
    lines: readonly Readonly<
      Omit<
        InvoiceProps["lines"][number],
        | "unitPriceMinor"
        | "discountMinor"
        | "netMinor"
        | "taxMinor"
        | "grossMinor"
        | "taxComponents"
      > & {
        unitPrice: MoneyJson;
        discount: MoneyJson;
        net: MoneyJson;
        tax: MoneyJson;
        gross: MoneyJson;
        taxComponents: readonly Readonly<{
          key: string;
          name: string;
          rate: string;
          amount: MoneyJson;
        }>[];
      }
    >[];
  }>;

export type InvoiceQuery = Omit<InvoiceListFilter, "branchIds" | "after" | "limit"> &
  Readonly<{ limit: number; cursor?: string }>;

/**
 * Invoices (docs/13 §2.1, §6): drafts edited freely; issuing numbers the invoice (INV-…),
 * snapshots the tax in force on the issue date and posts it (receivable against income and tax
 * payable per levy); voiding (no payments allocated) posts the reversal. Only VAT-registered
 * businesses charge tax.
 */
export class Invoicing {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      invoices: IInvoiceRepository;
      queries: IFinanceQueries;
      ledger: ILedger;
      posting: LedgerPosting;
      context: FinanceContext;
      settings: IFinanceSettingsStore;
      reference: ITenantReferenceData;
      organisation: IOrganisationSettings;
      vehicles: IVehicleRepository;
      scope: BranchScope;
      numbering: DocumentNumbering;
      calendar: TenantCalendar;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  async list(actor: Principal, query: InvoiceQuery): Promise<Page<InvoiceView>> {
    const { deps } = this;
    const after = query.cursor === undefined ? undefined : PageCursor.parse(query.cursor, 2).values;
    return deps.unitOfWork.run(async () => {
      const rows = await deps.queries.invoices({
        ...query,
        branchIds: deps.scope.branchesFor(actor, "finance.invoices.view"),
        limit: query.limit + 1,
        ...(after === undefined
          ? {}
          : { after: { createdAt: String(after[0]), id: String(after[1]) } }),
      });
      const page = PageCursor.paginate(rows, query.limit, (i) => [i.createdAt.toISOString(), i.id]);
      return { ...page, items: page.items.map(invoiceView) };
    });
  }

  async get(actor: Principal, id: string): Promise<InvoiceView> {
    return this.deps.unitOfWork.run(async () =>
      invoiceView((await this.reach(actor, id, "finance.invoices.view")).snapshot()),
    );
  }

  async create(actor: Principal, request: InvoiceRequest): Promise<InvoiceView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const branchId =
        request.branchId ??
        (await deps.scope.defaultBranch(actor, "finance.invoices.manage", "invoice"));
      await deps.scope.branch(actor, "finance.invoices.manage", branchId);
      const { header, lines, taxCodes } = await this.prepare(request, branchId);
      const invoice = Invoice.draft({
        id: deps.ids.next(),
        header,
        lines,
        taxCodes,
        source: null,
        createdBy: actor.userId,
        now: deps.clock.now(),
      });
      await deps.invoices.save(invoice);
      await this.audit(actor, "invoice.drafted", invoice);
      return invoiceView(invoice.snapshot());
    });
  }

  async revise(actor: Principal, id: string, request: InvoiceRequest): Promise<InvoiceView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const invoice = await this.reach(actor, id, "finance.invoices.manage", true);
      const branchId = request.branchId ?? invoice.snapshot().branchId;
      await deps.scope.branch(actor, "finance.invoices.manage", branchId);
      const { header, lines, taxCodes } = await this.prepare(request, branchId);
      invoice.revise(header, lines, taxCodes, deps.clock.now());
      await deps.invoices.save(invoice);
      await this.audit(actor, "invoice.revised", invoice);
      return invoiceView(invoice.snapshot());
    });
  }

  async deleteDraft(actor: Principal, id: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const invoice = await this.reach(actor, id, "finance.invoices.manage", true);
      if (invoice.status !== "draft")
        throw new FinanceRuleError("An issued invoice is voided, not deleted");
      await deps.invoices.deleteDraft(id);
      await this.audit(actor, "invoice.draft_deleted", invoice);
    });
  }

  async issue(actor: Principal, id: string): Promise<InvoiceView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const invoice = await this.reach(actor, id, "finance.invoices.manage", true);
      const p = invoice.snapshot();
      await deps.posting.assertOpen(p.issueDate);
      const number = await deps.numbering.next("invoice", new Date(`${p.issueDate}T12:00:00Z`));
      invoice.issue({
        number,
        taxCodes: await this.taxCodes(),
        issuedBy: actor.userId,
        now: deps.clock.now(),
      });
      const entry = Postings.invoiceIssued(
        invoice,
        await deps.posting.accounts(),
        await deps.posting.baseCurrency(),
      );
      invoice.posted(entry.lines.reduce((sum, l) => sum + l.debitMinor, 0));
      await deps.posting.post(entry, actor.userId);
      await deps.invoices.save(invoice);
      await this.audit(actor, "invoice.issued", invoice);
      return invoiceView(invoice.snapshot());
    });
  }

  async void(actor: Principal, id: string, reason: string): Promise<InvoiceView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const invoice = await this.reach(actor, id, "finance.invoices.void", true);
      invoice.void(reason, actor.userId, deps.clock.now());
      await deps.posting.reverse(
        { type: "invoice", id },
        await deps.calendar.today(),
        `Invoice ${invoice.snapshot().number ?? ""} voided: ${reason}`,
        actor.userId,
      );
      await deps.invoices.save(invoice);
      await this.audit(actor, "invoice.voided", invoice, { reason });
      return invoiceView(invoice.snapshot());
    });
  }

  /** The invoice within the caller's branches (call inside a unit of work). */
  async reach(
    actor: Principal,
    id: string,
    permission: PermissionKey,
    lock = false,
  ): Promise<Invoice> {
    const invoice = lock
      ? await this.deps.invoices.lockById(id)
      : await this.deps.invoices.findById(id);
    if (invoice === null) throw new InvoiceNotFoundError();
    await this.deps.scope.assertReaches(
      actor,
      permission,
      invoice.snapshot().branchId,
      () => new InvoiceNotFoundError(),
    );
    return invoice;
  }

  private async prepare(request: InvoiceRequest, branchId: string) {
    const { deps } = this;
    const today = await deps.calendar.today();
    const settings = await deps.settings.get();
    const tax = await deps.organisation.taxSettings();
    const party = await deps.context.party(request.partyType, request.partyId);
    const issueDate = request.issueDate ?? today;
    const { currency, fxRate } = await deps.context.rate(
      request.currency ?? (await deps.posting.baseCurrency()),
      issueDate,
      request.fxRate,
    );
    const taxCodes = await this.taxCodes();
    const accounts = await deps.ledger.accounts();
    const otherIncome = accounts.find((a) => a.systemKey === "other_income")!.id;
    const vehicleIds = new Set<string>();
    if (request.vehicleId !== undefined && request.vehicleId !== null)
      vehicleIds.add(request.vehicleId);
    const lines: InvoiceLineInput[] = request.lines.map((line, index) => {
      const taxCode = line.taxCode === undefined ? tax.defaultSalesTaxCode : line.taxCode;
      if (taxCode !== null) {
        if (tax.scheme === "not_registered")
          throw new FinanceRuleError(
            `Line ${index + 1}: only VAT-registered businesses charge tax (Settings → Tax)`,
          );
        const code = taxCodes.get(taxCode);
        if (code === undefined || !code.active || !code.snapshot().appliesTo.includes("sales"))
          throw new FinanceRuleError(
            `Line ${index + 1}: ${taxCode} is not an active sales tax code`,
          );
      }
      const accountId = line.accountId ?? otherIncome;
      const account = accounts.find((a) => a.id === accountId);
      if (account?.type !== "income" || !account.active)
        throw new FinanceRuleError(`Line ${index + 1}: choose an active income account`);
      if (line.vehicleId !== undefined && line.vehicleId !== null) vehicleIds.add(line.vehicleId);
      return {
        description: line.description,
        quantity: line.quantity,
        unitPriceMinor: Money.parse(line.unitPrice, currency).amountMinor,
        discountMinor:
          line.discount === undefined ? 0 : Money.parse(line.discount, currency).amountMinor,
        taxCode,
        accountId,
        vehicleId: line.vehicleId ?? null,
      };
    });
    for (const vehicleId of vehicleIds)
      if ((await deps.vehicles.findById(vehicleId)) === null)
        throw new FinanceRuleError("One of the vehicles does not exist");
    return {
      header: {
        partyType: request.partyType,
        partyId: request.partyId,
        partyName: party.name,
        branchId,
        vehicleId: request.vehicleId ?? null,
        issueDate,
        dueDate: request.dueDate ?? TenantCalendar.addDays(issueDate, settings.defaultDueDays),
        currency,
        fxRate,
        pricesIncludeTax: tax.pricesIncludeTax,
        notes: request.notes ?? null,
      },
      lines,
      taxCodes,
    };
  }

  private async taxCodes(): Promise<Map<string, TaxCode>> {
    const codes = await this.deps.reference.taxCodes();
    return new Map(codes.map((props) => [props.code, TaxCode.create(props)]));
  }

  private async audit(
    actor: Principal,
    action: string,
    invoice: Invoice,
    metadata?: Readonly<Record<string, unknown>>,
  ) {
    const p = invoice.snapshot();
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: "invoice",
      entityId: p.id,
      after: {
        number: p.number,
        status: p.status,
        party: { type: p.partyType, id: p.partyId },
        totalMinor: p.totalMinor,
        currency: p.currency,
      },
      ...(metadata === undefined ? {} : { metadata }),
    });
  }
}

export function invoiceView(p: InvoiceProps): InvoiceView {
  const m = (minor: number) => Money.ofMinor(minor, p.currency).toJSON();
  const breakdown = new Map<
    string,
    { key: string; name: string; rate: string; amountMinor: number }
  >();
  for (const line of p.lines)
    for (const c of line.taxComponents) {
      const key = `${c.key}|${c.rate}`;
      const current = breakdown.get(key);
      breakdown.set(key, { ...c, amountMinor: (current?.amountMinor ?? 0) + c.amountMinor });
    }
  const {
    subtotalMinor,
    taxMinor,
    totalMinor,
    paidMinor,
    totalBaseMinor: _base,
    lines,
    ...rest
  } = p;
  return {
    ...rest,
    subtotal: m(subtotalMinor),
    tax: m(taxMinor),
    total: m(totalMinor),
    paid: m(paidMinor),
    balance: m(totalMinor - paidMinor),
    taxBreakdown: [...breakdown.values()].map(({ amountMinor, ...c }) => ({
      ...c,
      amount: m(amountMinor),
    })),
    lines: lines.map(
      ({
        unitPriceMinor,
        discountMinor,
        netMinor,
        taxMinor: lineTax,
        grossMinor,
        taxComponents,
        ...line
      }) => ({
        ...line,
        unitPrice: m(unitPriceMinor),
        discount: m(discountMinor),
        net: m(netMinor),
        tax: m(lineTax),
        gross: m(grossMinor),
        taxComponents: taxComponents.map(({ amountMinor, ...c }) => ({
          ...c,
          amount: m(amountMinor),
        })),
      }),
    ),
  };
}
