import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import {
  landedCost,
  type Allocation,
  type CostKind,
  type CountedCost,
  type LineLandedCost,
} from "../../../domain/purchases/LandedCost.js";
import {
  Purchase,
  PurchaseRuleError,
  type ImportStage,
  type NewLine,
  type PurchaseDetails,
  type PurchaseLine,
  type PurchaseLineDetails,
  type PurchaseProps,
  type PurchaseStatus,
  type PurchaseType,
  type Shipping,
} from "../../../domain/purchases/Purchase.js";
import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import type { MileageUnit, VehicleUsage } from "../../../domain/vehicles/Vehicle.js";
import type { Principal } from "../../authorization/Principal.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IExpenseSourceHook } from "../../ports/IExpenseSourceHooks.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IPurchases, PurchaseCostRecord, PurchaseEvent } from "../../ports/IPurchases.js";
import type { ITenantReferenceData } from "../../ports/IReferenceData.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { Expenses } from "../expenses/Expenses.js";
import type { FileView, UploadStarted } from "../files/FileService.js";
import type { DocumentUploadInput, OwnedDocuments } from "../files/OwnedDocuments.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { CurrencySettingsService } from "../reference/CurrencySettingsService.js";
import type { DocumentNumbering } from "../reference/DocumentNumbering.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { VehicleRegistry } from "../vehicles/VehicleRegistry.js";

export class PurchaseNotFoundError extends ApplicationError {
  readonly code = "PURCHASE_NOT_FOUND";
  constructor() {
    super("Purchase not found");
  }
}

export class PurchaseCostNotFoundError extends ApplicationError {
  readonly code = "PURCHASE_COST_NOT_FOUND";
  constructor() {
    super("Cost not found on this purchase");
  }
}

/** The expense source of a purchase cost: its id is the cost's. */
export const PURCHASE_COST_SOURCE = "purchase_cost";
export const PURCHASE_CATEGORY = "vehicle_purchase";
/** Days at the port before demurrage when the import does not say (decision 427). */
export const DEFAULT_PORT_FREE_DAYS = 7;
const COUNTED = new Set(["approved", "paid"]);
const PENDING = new Set(["draft", "submitted"]);

export type LineInput = PurchaseLineDetails & Readonly<{ price: string }>;

export type PurchaseRequest = Readonly<{
  type: PurchaseType;
  supplierId: string;
  branchId?: string;
  currency?: string;
  reference?: string | null;
  expectedOn?: string | null;
  notes?: string | null;
  lines: readonly LineInput[];
}>;

export type CostInput = Readonly<{
  kind: CostKind;
  /** The vehicle it belongs to; none: shared by the purchase's vehicles. */
  lineId?: string | null;
  allocation?: Allocation;
  description?: string | null;
  supplierId: string;
  amount: string;
  /** Default: the base currency. */
  currency?: string;
  fxRate?: string | null;
  date?: string;
  taxCode?: string | null;
  reference?: string | null;
}>;

export type ReceiveInput = Readonly<{
  receivedOn?: string;
  branchId?: string;
  status?: "available" | "reconditioning";
  usage?: VehicleUsage;
  plateNumber?: string | null;
  odometer?: number | null;
  mileageUnit?: MileageUnit;
}>;

export type PurchaseQuery = Readonly<{
  branchId?: string;
  supplierId?: string;
  statuses?: readonly PurchaseStatus[];
  types?: readonly PurchaseType[];
  limit: number;
  beforeId?: string;
}>;

type Landed = Readonly<{
  price: MoneyJson;
  direct: MoneyJson;
  shared: MoneyJson;
  total: MoneyJson;
  pending: MoneyJson;
}>;

export type PurchaseCostView = Readonly<{
  id: string;
  lineId: string | null;
  kind: CostKind;
  allocation: Allocation;
  description: string;
  supplier: Readonly<{ id: string; name: string }>;
  expense: Readonly<{ id: string; number: string | null; status: string }>;
  amount: MoneyJson;
  fxRate: string;
  amountBase: MoneyJson;
  /** What it added to the vehicles' cost (approved or paid); null while it does not count. */
  capitalised: MoneyJson | null;
  paid: boolean;
}>;

export type PurchaseView = Omit<PurchaseProps, "lines"> &
  Readonly<{
    supplierName: string;
    daysAtPort: number | null;
    lines: readonly (Omit<PurchaseLine, "priceMinor"> &
      Readonly<{ price: MoneyJson; landedCost: Landed }>)[];
    costs: readonly PurchaseCostView[];
    totals: Readonly<{ capitalised: MoneyJson; pending: MoneyJson; paid: MoneyJson }>;
    events: readonly PurchaseEvent[];
  }>;

export type PurchaseSummary = Omit<PurchaseProps, "lines"> &
  Readonly<{ vehicles: number; received: number; total: MoneyJson }>;

/**
 * Vehicle purchases (docs/11 §3–6): drafts with one line per vehicle; ordering raises each
 * vehicle's price as an expense to the seller; cost components in any currency to any supplier
 * are expenses capitalised to 1500 Vehicles; the landed cost per vehicle; the import timeline and
 * documents; receiving a line registers its vehicle at its landed cost, kept up to date as late
 * costs are posted (decisions 421–428).
 */
export class Purchases {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      purchases: IPurchases;
      expenses: Expenses;
      registry: VehicleRegistry;
      vehicles: IVehicleRepository;
      reference: ITenantReferenceData;
      currencies: CurrencySettingsService;
      organisation: IOrganisationSettings;
      posting: LedgerPosting;
      scope: BranchScope;
      numbering: DocumentNumbering;
      documents: OwnedDocuments;
      calendar: TenantCalendar;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  list(actor: Principal, query: PurchaseQuery): Promise<PurchaseSummary[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (query.branchId !== undefined)
        await deps.scope.branch(actor, "purchases.view", query.branchId);
      const purchases = await deps.purchases.list({
        branchIds: deps.scope.branchesFor(actor, "purchases.view"),
        ...query,
      });
      return purchases.map((purchase) => {
        const { lines, ...p } = purchase.snapshot();
        return {
          ...p,
          vehicles: lines.length,
          received: lines.filter((l) => l.vehicleId !== null).length,
          total: Money.ofMinor(
            lines.reduce((s, l) => s + l.priceMinor, 0),
            p.currency,
          ).toJSON(),
        };
      });
    });
  }

  get(actor: Principal, id: string): Promise<PurchaseView> {
    return this.deps.unitOfWork.run(async () =>
      this.view(await this.reach(actor, id, "purchases.view")),
    );
  }

  create(actor: Principal, request: PurchaseRequest): Promise<PurchaseView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const branchId =
        request.branchId ?? (await deps.scope.defaultBranch(actor, "purchases.create", "purchase"));
      await deps.scope.branch(actor, "purchases.create", branchId);
      const details = await this.details(request, branchId);
      const now = deps.clock.now();
      const purchase = Purchase.draft({
        ...details,
        id: deps.ids.next(),
        number: await deps.numbering.next("purchase", now),
        lines: this.lines(request.lines, details.currency, []),
        createdBy: actor.userId,
        now,
      });
      await deps.purchases.insert(purchase);
      await this.event(purchase, "created", actor, { occurredOn: await deps.calendar.today() });
      await this.audit(actor, "purchase.created", purchase);
      return this.view(purchase);
    });
  }

  revise(actor: Principal, id: string, request: PurchaseRequest): Promise<PurchaseView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const purchase = await this.reach(actor, id, "purchases.create", true);
      const branchId = request.branchId ?? purchase.snapshot().branchId;
      await deps.scope.branch(actor, "purchases.create", branchId);
      const details = await this.details(request, branchId);
      purchase.revise(
        details,
        this.lines(request.lines, details.currency, purchase.snapshot().lines),
        deps.clock.now(),
      );
      await deps.purchases.update(purchase);
      await this.audit(actor, "purchase.revised", purchase);
      return this.view(purchase);
    });
  }

  /**
   * Orders the purchase: each vehicle's price becomes a cost to the seller in the purchase's
   * currency (an expense submitted for approval; decision 422).
   */
  order(
    actor: Principal,
    id: string,
    input: Readonly<{ orderedOn?: string; fxRate?: string | null }>,
  ): Promise<PurchaseView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const purchase = await this.reach(actor, id, "purchases.approve", true);
      const on = input.orderedOn ?? (await deps.calendar.today());
      purchase.order(on, actor.userId, deps.clock.now());
      await deps.purchases.update(purchase);
      const p = purchase.snapshot();
      for (const line of p.lines)
        if (line.priceMinor > 0)
          await this.raiseCost(actor, purchase, {
            kind: "vehicle_price",
            lineId: line.id,
            supplierId: p.supplierId,
            amount: Money.ofMinor(line.priceMinor, p.currency).toDecimalString(),
            currency: p.currency,
            fxRate: input.fxRate ?? null,
            date: on,
            reference: p.reference,
          });
      await this.refresh(purchase.id);
      await this.event(purchase, "ordered", actor, { occurredOn: on });
      await this.audit(actor, "purchase.ordered", purchase);
      return this.view(purchase);
    });
  }

  addCost(actor: Principal, id: string, input: CostInput): Promise<PurchaseView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const purchase = await this.reach(actor, id, "purchases.costs.manage", true);
      purchase.assertTakesCosts();
      await this.raiseCost(actor, purchase, input);
      await this.refresh(purchase.id);
      await this.audit(actor, "purchase.cost_added", purchase, { kind: input.kind });
      return this.view(purchase);
    });
  }

  /** Removes a cost by voiding its expense (a paid one: reverse the payment first). */
  removeCost(actor: Principal, id: string, costId: string, reason: string): Promise<PurchaseView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const purchase = await this.reach(actor, id, "purchases.costs.manage", true);
      const cost = (await deps.purchases.costs(purchase.id)).find((c) => c.id === costId);
      if (cost === undefined) throw new PurchaseCostNotFoundError();
      if (cost.expenseStatus === "void")
        throw new PurchaseRuleError("That cost is already removed");
      await deps.expenses.voidFor(cost.expenseId, actor.userId, reason);
      await this.refresh(purchase.id);
      await this.audit(actor, "purchase.cost_removed", purchase, { costId, reason });
      return this.view(purchase);
    });
  }

  setShipping(actor: Principal, id: string, shipping: Partial<Shipping>): Promise<PurchaseView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const purchase = await this.reach(actor, id, "purchases.create", true);
      const p = purchase.snapshot();
      purchase.setShipping(
        {
          vessel: shipping.vessel === undefined ? p.vessel : shipping.vessel,
          billOfLading:
            shipping.billOfLading === undefined ? p.billOfLading : shipping.billOfLading,
          containerNumber:
            shipping.containerNumber === undefined ? p.containerNumber : shipping.containerNumber,
          eta: shipping.eta === undefined ? p.eta : shipping.eta,
          portFreeDays:
            shipping.portFreeDays === undefined ? p.portFreeDays : shipping.portFreeDays,
        },
        deps.clock.now(),
      );
      await deps.purchases.update(purchase);
      await this.audit(actor, "purchase.shipping_updated", purchase);
      return this.view(purchase);
    });
  }

  /** Moves an import along its timeline (decision 426). */
  advance(
    actor: Principal,
    id: string,
    input: Readonly<{ stage: ImportStage; on?: string; note?: string | null }>,
  ): Promise<PurchaseView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const purchase = await this.reach(actor, id, "purchases.create", true);
      const on = input.on ?? (await deps.calendar.today());
      purchase.advance(input.stage, on, deps.clock.now());
      await deps.purchases.update(purchase);
      await this.event(purchase, "stage", actor, {
        occurredOn: on,
        stage: input.stage,
        note: input.note ?? null,
      });
      await this.audit(actor, "purchase.stage_changed", purchase, { stage: input.stage });
      return this.view(purchase);
    });
  }

  addNote(
    actor: Principal,
    id: string,
    input: Readonly<{ note: string; on?: string }>,
  ): Promise<PurchaseView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const purchase = await this.reach(actor, id, "purchases.create");
      if (input.note.trim().length === 0) throw new PurchaseRuleError("Write the note");
      await this.event(purchase, "note", actor, {
        occurredOn: input.on ?? (await deps.calendar.today()),
        note: input.note.trim(),
      });
      return this.view(purchase);
    });
  }

  editLine(
    actor: Principal,
    id: string,
    lineId: string,
    details: Partial<PurchaseLineDetails>,
  ): Promise<PurchaseView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const purchase = await this.reach(actor, id, "purchases.create", true);
      const line = purchase.line(lineId);
      purchase.editLine(
        lineId,
        {
          vin: details.vin === undefined ? line.vin : details.vin,
          make: details.make ?? line.make,
          model: details.model ?? line.model,
          year: details.year === undefined ? line.year : details.year,
          colour: details.colour === undefined ? line.colour : details.colour,
          description: details.description === undefined ? line.description : details.description,
        },
        deps.clock.now(),
      );
      await deps.purchases.update(purchase);
      await this.audit(actor, "purchase.line_edited", purchase, { lineId });
      return this.view(purchase);
    });
  }

  /**
   * Receives a line: registers its vehicle (the receiver also needs `vehicles.create`) acquired on
   * the receipt date at its landed cost so far (decision 425).
   */
  receive(
    actor: Principal,
    id: string,
    lineId: string,
    input: ReceiveInput,
  ): Promise<PurchaseView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const purchase = await this.reach(actor, id, "purchases.receive", true);
      const p = purchase.snapshot();
      const line = purchase.line(lineId);
      if (p.status !== "ordered") throw new PurchaseRuleError("Order the purchase first");
      if (line.vehicleId !== null) throw new PurchaseRuleError("That vehicle is already received");
      const receivedOn = input.receivedOn ?? (await deps.calendar.today());
      const prepared = await deps.registry.prepare(actor, {
        branchId: input.branchId ?? p.branchId,
        status: input.status ?? "reconditioning",
        make: line.make,
        model: line.model,
        year: line.year,
        vin: line.vin,
        colour: line.colour,
        plateNumber: input.plateNumber ?? null,
        usage: input.usage ?? "fleet",
        ...(input.mileageUnit === undefined ? {} : { mileageUnit: input.mileageUnit }),
        odometer: input.odometer ?? null,
        notes: `Bought on purchase ${p.number}`,
      });
      const landed = (await this.landed(purchase)).find((l) => l.lineId === lineId)!;
      prepared.vehicle.updateFinancials(
        {
          acquisitionDate: receivedOn,
          acquisitionCostMinor: landed.totalMinor,
          residualValueMinor: null,
          depreciationMethod: "none",
          usefulLifeMonths: null,
        },
        deps.clock.now(),
      );
      await deps.registry.persist(actor, prepared, "manual");
      purchase.receive(lineId, prepared.vehicle.id, receivedOn, actor.userId, deps.clock.now());
      await deps.purchases.update(purchase);
      await this.event(purchase, "received", actor, {
        occurredOn: receivedOn,
        details: { lineId, vehicleId: prepared.vehicle.id, code: prepared.vehicle.snapshot().code },
      });
      await this.audit(actor, "purchase.line_received", purchase, {
        lineId,
        vehicleId: prepared.vehicle.id,
      });
      return this.view(purchase);
    });
  }

  /** Cancels before anything was received, voiding its unpaid costs (decision 428). */
  cancel(actor: Principal, id: string, reason: string): Promise<PurchaseView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const purchase = await this.reach(actor, id, "purchases.approve", true);
      const costs = await deps.purchases.costs(purchase.id);
      if (costs.some((c) => c.expenseStatus === "paid"))
        throw new PurchaseRuleError("A cost is already paid: reverse its payment first");
      purchase.cancel(reason, actor.userId, deps.clock.now());
      for (const c of costs)
        if (c.expenseStatus !== "void")
          await deps.expenses.voidFor(c.expenseId, actor.userId, `Purchase cancelled: ${reason}`);
      await deps.purchases.update(purchase);
      await this.event(purchase, "cancelled", actor, {
        occurredOn: await deps.calendar.today(),
        note: reason.trim(),
      });
      await this.audit(actor, "purchase.cancelled", purchase, { reason });
      return this.view(purchase);
    });
  }

  /** Keeps the received vehicles' acquisition cost equal to their landed cost. */
  async refresh(purchaseId: string): Promise<void> {
    const { deps } = this;
    const purchase = await deps.purchases.get(purchaseId);
    if (purchase === null) return;
    const landed = await this.landed(purchase);
    for (const line of purchase.snapshot().lines) {
      if (line.vehicleId === null) continue;
      const cost = landed.find((l) => l.lineId === line.id)!.totalMinor;
      const vehicle = await deps.vehicles.lockById(line.vehicleId);
      if (vehicle === null) continue;
      const v = vehicle.snapshot();
      if (v.acquisitionCostMinor === cost) continue;
      vehicle.updateFinancials(
        {
          acquisitionDate: v.acquisitionDate,
          acquisitionCostMinor: cost,
          residualValueMinor:
            v.residualValueMinor === null ? null : Math.min(v.residualValueMinor, cost),
          depreciationMethod: v.depreciationMethod,
          usefulLifeMonths: v.usefulLifeMonths,
        },
        deps.clock.now(),
      );
      await deps.vehicles.save(vehicle);
    }
  }

  startDocument(actor: Principal, id: string, input: DocumentUploadInput): Promise<UploadStarted> {
    return this.deps.unitOfWork
      .run(() => this.reach(actor, id, "purchases.create"))
      .then(() => this.deps.documents.start(id, input, actor.userId));
  }

  async completeDocument(actor: Principal, id: string, fileId: string): Promise<FileView> {
    await this.deps.unitOfWork.run(() => this.reach(actor, id, "purchases.create"));
    return this.deps.documents.complete(id, fileId);
  }

  async listDocuments(actor: Principal, id: string): Promise<FileView[]> {
    await this.deps.unitOfWork.run(() => this.reach(actor, id, "purchases.view"));
    return this.deps.documents.list(id);
  }

  async removeDocument(actor: Principal, id: string, fileId: string): Promise<void> {
    await this.deps.unitOfWork.run(() => this.reach(actor, id, "purchases.create"));
    await this.deps.documents.remove(id, fileId);
  }

  // --- internals ---

  /** Raises a cost as an expense to its payee and records it on the purchase. */
  private async raiseCost(actor: Principal, purchase: Purchase, input: CostInput): Promise<void> {
    const { deps } = this;
    const p = purchase.snapshot();
    const line =
      input.lineId === undefined || input.lineId === null ? null : purchase.line(input.lineId);
    if (input.kind === "vehicle_price" && line === null)
      throw new PurchaseRuleError("A vehicle's price belongs to one vehicle");
    if (!(await deps.purchases.supplierExists(input.supplierId)))
      throw new PurchaseRuleError("The payee is not an active supplier");
    const category = (await deps.reference.expenseCategories()).find(
      (c) => c.code === PURCHASE_CATEGORY,
    );
    if (category === undefined || !category.active)
      throw new PurchaseRuleError(`There is no active "${PURCHASE_CATEGORY}" expense category`);
    const costId = deps.ids.next();
    const what =
      line === null
        ? `all vehicles`
        : [line.year, line.make, line.model, line.vin].filter((x) => x !== null).join(" ");
    const description = input.description?.trim() || `${input.kind.replaceAll("_", " ")} — ${what}`;
    const expense = await deps.expenses.draftFor(
      actor.userId,
      {
        categoryId: category.id,
        description: `${p.number}: ${description}`.slice(0, 300),
        branchId: p.branchId,
        expenseDate: input.date ?? (await deps.calendar.today()),
        payeeType: "supplier",
        payeeId: input.supplierId,
        amount: input.amount,
        // Added costs are local by default (duty, clearing …); prices come in the purchase's.
        currency: input.currency ?? (await deps.posting.baseCurrency()),
        fxRate: input.fxRate ?? null,
        ...(input.taxCode === undefined ? {} : { taxCode: input.taxCode }),
        ...(line?.vehicleId ? { vehicleIds: [line.vehicleId] } : {}),
        reference: input.reference ?? null,
      },
      p.branchId,
      { type: PURCHASE_COST_SOURCE, id: costId },
      actor,
    );
    await deps.purchases.addCost({
      id: costId,
      purchaseId: p.id,
      lineId: line?.id ?? null,
      kind: input.kind,
      allocation: input.allocation ?? "value",
      description: description.slice(0, 300),
      supplierId: input.supplierId,
      expenseId: expense.id,
      createdBy: actor.userId,
    });
    await deps.expenses.submitLoaded(expense, actor.userId, { skipReceiptRule: true });
  }

  private async details(request: PurchaseRequest, branchId: string): Promise<PurchaseDetails> {
    const { deps } = this;
    if (!(await deps.purchases.supplierExists(request.supplierId)))
      throw new PurchaseRuleError("The seller is not an active supplier");
    const currency = request.currency ?? (await deps.posting.baseCurrency());
    await deps.currencies.assertEnabled(currency);
    return {
      type: request.type,
      supplierId: request.supplierId,
      branchId,
      currency,
      reference: request.reference ?? null,
      expectedOn: request.expectedOn ?? null,
      notes: request.notes ?? null,
    };
  }

  /** Lines from the request; a line keeps its id when it repeats one already on the draft. */
  private lines(
    input: readonly LineInput[],
    currency: string,
    current: readonly PurchaseLine[],
  ): NewLine[] {
    return input.map((l, i) => ({
      id: current[i]?.id ?? this.deps.ids.next(),
      vin: l.vin,
      make: l.make,
      model: l.model,
      year: l.year,
      colour: l.colour,
      description: l.description,
      priceMinor: Money.parse(l.price, currency).amountMinor,
    }));
  }

  /** Each line's landed cost from the costs that posted (decision 424). */
  private async landed(purchase: Purchase): Promise<LineLandedCost[]> {
    const { deps } = this;
    const costs = await deps.purchases.costs(purchase.id);
    const recoverTax = (await deps.organisation.taxSettings()).scheme !== "not_registered";
    return landedCost(
      purchase.snapshot().lines.map((l) => l.id),
      costs.filter((c) => COUNTED.has(c.expenseStatus)).map((c) => counted(c, recoverTax)),
      await deps.posting.baseCurrency(),
    );
  }

  private async view(purchase: Purchase): Promise<PurchaseView> {
    const { deps } = this;
    const { lines, ...p } = purchase.snapshot();
    const base = await deps.posting.baseCurrency();
    const m = (minor: number) => Money.ofMinor(minor, base).toJSON();
    const costs = await deps.purchases.costs(purchase.id);
    const recoverTax = (await deps.organisation.taxSettings()).scheme !== "not_registered";
    const landed = await this.landed(purchase);
    const pending = landedCost(
      lines.map((l) => l.id),
      costs.filter((c) => PENDING.has(c.expenseStatus)).map((c) => counted(c, recoverTax)),
      base,
    );
    const capitalisedOf = (c: PurchaseCostRecord) =>
      COUNTED.has(c.expenseStatus) ? counted(c, recoverTax).baseMinor : null;
    const today = await deps.calendar.today();
    const supplierName =
      costs.find((c) => c.supplierId === p.supplierId)?.supplierName ??
      (await deps.purchases.supplierName(p.supplierId));
    return {
      ...p,
      supplierName,
      daysAtPort:
        p.arrivedOn === null
          ? null
          : daysBetween(p.arrivedOn, p.releasedOn ?? p.receivedOn ?? today),
      lines: lines.map(({ priceMinor, ...l }) => {
        const own = landed.find((x) => x.lineId === l.id)!;
        return {
          ...l,
          price: Money.ofMinor(priceMinor, p.currency).toJSON(),
          landedCost: {
            price: m(own.priceMinor),
            direct: m(own.directMinor),
            shared: m(own.sharedMinor),
            total: m(own.totalMinor),
            pending: m(pending.find((x) => x.lineId === l.id)!.totalMinor),
          },
        };
      }),
      costs: costs.map((c) => {
        const capitalised = capitalisedOf(c);
        return {
          id: c.id,
          lineId: c.lineId,
          kind: c.kind,
          allocation: c.allocation,
          description: c.description,
          supplier: { id: c.supplierId, name: c.supplierName },
          expense: { id: c.expenseId, number: c.expenseNumber, status: c.expenseStatus },
          amount: Money.ofMinor(c.amountMinor, c.currency).toJSON(),
          fxRate: c.fxRate,
          amountBase: m(c.amountBaseMinor),
          capitalised: capitalised === null ? null : m(capitalised),
          paid: c.expenseStatus === "paid",
        };
      }),
      totals: {
        capitalised: m(costs.reduce((s, c) => s + (capitalisedOf(c) ?? 0), 0)),
        pending: m(
          costs
            .filter((c) => PENDING.has(c.expenseStatus))
            .reduce((s, c) => s + counted(c, recoverTax).baseMinor, 0),
        ),
        paid: m(
          costs
            .filter((c) => c.expenseStatus === "paid")
            .reduce((s, c) => s + c.amountBaseMinor, 0),
        ),
      },
      events: await deps.purchases.events(purchase.id),
    };
  }

  private async reach(
    actor: Principal,
    id: string,
    permission: PermissionKey,
    lock = false,
  ): Promise<Purchase> {
    const { deps } = this;
    const purchase = lock ? await deps.purchases.lock(id) : await deps.purchases.get(id);
    if (purchase === null || !deps.scope.can(actor, permission, purchase.snapshot().branchId))
      throw new PurchaseNotFoundError();
    return purchase;
  }

  private async event(
    purchase: Purchase,
    kind: PurchaseEvent["kind"],
    actor: Principal,
    e: Readonly<{
      occurredOn: string;
      stage?: ImportStage;
      note?: string | null;
      details?: PurchaseEvent["details"];
    }>,
  ): Promise<void> {
    const { deps } = this;
    await deps.purchases.addEvent({
      id: deps.ids.next(),
      purchaseId: purchase.id,
      kind,
      stage: e.stage ?? null,
      occurredOn: e.occurredOn,
      note: e.note ?? null,
      details: e.details ?? {},
      recordedBy: actor.userId,
      recordedAt: deps.clock.now(),
    });
  }

  private async audit(
    actor: Principal,
    action: string,
    purchase: Purchase,
    metadata?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const { lines, ...p } = purchase.snapshot();
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: "purchase",
      entityId: purchase.id,
      after: { ...p, vehicles: lines.length },
      ...(metadata === undefined ? {} : { metadata }),
    });
  }
}

/** What a cost posted to the vehicles: net of recoverable VAT (decision 423). */
function counted(c: PurchaseCostRecord, recoverTax: boolean): CountedCost {
  return {
    lineId: c.lineId,
    kind: c.kind,
    allocation: c.allocation,
    baseMinor: recoverTax ? c.netBaseMinor : c.amountBaseMinor,
  };
}

function daysBetween(from: string, to: string): number {
  return Math.max(
    0,
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000),
  );
}

/** Follows the posting of purchase cost expenses into the vehicles' cost. */
export class PurchaseCostHook implements IExpenseSourceHook {
  readonly sourceType = PURCHASE_COST_SOURCE;

  constructor(private readonly deps: Readonly<{ purchases: IPurchases; book: () => Purchases }>) {}

  async postingChanged(costId: string): Promise<void> {
    const purchaseId = await this.deps.purchases.purchaseOfCost(costId);
    if (purchaseId !== null) await this.deps.book().refresh(purchaseId);
  }
}
