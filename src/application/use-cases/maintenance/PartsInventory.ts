import { credit, debit, journal, type JournalLine } from "../../../domain/finance/Journal.js";
import {
  Part,
  PartRuleError,
  type MoveKind,
  type PartDetails,
  type PartProps,
  type PartUnit,
  type Stock,
  type StockChange,
  type StockProps,
} from "../../../domain/maintenance/Part.js";
import type { WorkOrder } from "../../../domain/maintenance/WorkOrder.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import type { Principal } from "../../authorization/Principal.js";
import { PermissionDeniedError } from "../../errors/AuthErrors.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IExpenseSettingsStore } from "../../ports/IExpenseRecords.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { INotificationSettingsStore } from "../../ports/INotifications.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IParts, PartMove, StockRow } from "../../ports/IParts.js";
import type { ITenantReferenceData } from "../../ports/IReferenceData.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { Expenses } from "../expenses/Expenses.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { Notifier } from "../notifications/Notifier.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { VehicleAccess } from "../vehicles/VehicleAccess.js";

export class PartNotFoundError extends ApplicationError {
  readonly code = "PART_NOT_FOUND";
  constructor() {
    super("Part not found");
  }
}

/** The expense category purchases for stock are entered in (seeded, posted to the inventory). */
const STOCK_CATEGORY = "parts_stock";

export type PartInput = Readonly<{
  sku: string;
  name: string;
  unit?: PartUnit;
  category?: string | null;
  compatible?: readonly Readonly<{ make: string; model?: string | null }>[];
  notes?: string | null;
  active?: boolean;
}>;

export type PartQuery = Readonly<{
  search?: string;
  category?: string;
  /** Only parts that fit this vehicle. */
  vehicleId?: string;
  includeInactive?: boolean;
  limit: number;
}>;

export type StockView = Omit<StockProps, "avgCostMinor"> &
  Readonly<{
    sku: string;
    name: string;
    unit: string;
    branchName: string;
    avgCost: MoneyJson;
    value: MoneyJson;
    low: boolean;
  }>;

export type MoveView = Omit<PartMove, "unitCostMinor" | "valueMinor" | "avgCostAfter"> &
  Readonly<{ unitCost: MoneyJson; value: MoneyJson; avgCostAfter: MoneyJson }>;

type Where = Readonly<{ partId: string; branchId: string }>;

/**
 * Parts inventory, basic (docs/12 §4): the catalogue with the models each part fits, stock per
 * branch at weighted average cost with reorder levels, and the moves — opening stock, purchases
 * (an expense to the supplier, posted to the inventory), issues to work orders on completion,
 * counts and transfers — each posted to the ledger (decisions 389–395).
 */
export class PartsInventory {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      parts: IParts;
      vehicles: IVehicleRepository;
      vehicleAccess: VehicleAccess;
      expenses: Expenses;
      expenseSettings: IExpenseSettingsStore;
      reference: ITenantReferenceData;
      posting: LedgerPosting;
      organisation: IOrganisationSettings;
      settings: INotificationSettingsStore;
      notifier: Notifier;
      calendar: TenantCalendar;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: { now(): Date };
    }>,
  ) {}

  // --- the catalogue ---

  list(actor: Principal, query: PartQuery): Promise<PartProps[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      let fits: ((p: Part) => boolean) | null = null;
      if (query.vehicleId !== undefined) {
        const v = (
          await deps.vehicleAccess.reach(actor, query.vehicleId, "maintenance.view")
        ).snapshot();
        fits = (p) => p.fits(v.make, v.model);
      }
      const parts = await deps.parts.list({
        ...(query.search === undefined ? {} : { search: query.search }),
        ...(query.category === undefined ? {} : { category: query.category }),
        includeInactive: query.includeInactive ?? false,
        limit: fits === null ? query.limit : 1_000,
      });
      return parts
        .filter((p) => fits === null || fits(p))
        .slice(0, query.limit)
        .map((p) => p.snapshot());
    });
  }

  get(actor: Principal, id: string): Promise<PartProps & Readonly<{ stock: StockView[] }>> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const part = await this.part(id);
      const rows = await deps.parts.stockOf(
        id,
        deps.vehicleAccess.branchesFor(actor, "maintenance.view"),
      );
      const currency = await this.currency();
      return { ...part.snapshot(), stock: rows.map((r) => stockView(r, currency)) };
    });
  }

  create(actor: Principal, input: PartInput): Promise<PartProps> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      this.assertManager(actor);
      const part = Part.create({
        id: deps.ids.next(),
        sku: input.sku,
        name: input.name,
        unit: input.unit ?? "each",
        category: input.category ?? null,
        compatible: fits(input.compatible ?? []),
        notes: input.notes ?? null,
        active: input.active ?? true,
        createdBy: actor.userId,
        now: deps.clock.now(),
      });
      if (await deps.parts.skuTaken(part.snapshot().sku, null))
        throw new PartRuleError(`There is already a part ${part.snapshot().sku}`);
      await deps.parts.insert(part);
      await this.audit(actor, "part.created", part.id, null, part.snapshot());
      return part.snapshot();
    });
  }

  update(actor: Principal, id: string, input: Partial<PartInput>): Promise<PartProps> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      this.assertManager(actor);
      const part = await this.part(id);
      const before = part.snapshot();
      const { compatible, ...rest } = input;
      const changes: Partial<PartDetails> = Object.fromEntries(
        Object.entries(rest).filter(([, v]) => v !== undefined),
      );
      part.change(
        { ...changes, ...(compatible === undefined ? {} : { compatible: fits(compatible) }) },
        deps.clock.now(),
      );
      if (await deps.parts.skuTaken(part.snapshot().sku, id))
        throw new PartRuleError(`There is already a part ${part.snapshot().sku}`);
      await deps.parts.update(part);
      await this.audit(actor, "part.updated", id, before, part.snapshot());
      return part.snapshot();
    });
  }

  // --- stock ---

  stock(
    actor: Principal,
    query: Readonly<{ branchId?: string; low?: boolean }>,
  ): Promise<StockView[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (query.branchId !== undefined)
        await deps.vehicleAccess.branch(actor, "maintenance.view", query.branchId);
      const rows = await deps.parts.stock({
        branchIds: deps.vehicleAccess.branchesFor(actor, "maintenance.view"),
        ...(query.branchId === undefined ? {} : { branchId: query.branchId }),
        ...(query.low === undefined ? {} : { low: query.low }),
      });
      const currency = await this.currency();
      return rows.map((r) => stockView(r, currency));
    });
  }

  /** The reorder level and quantity and the bin of a part at a branch. */
  setStock(
    actor: Principal,
    where: Where,
    input: Readonly<{
      reorderLevel: number | null;
      reorderQty: number | null;
      location?: string | null;
    }>,
  ): Promise<StockView> {
    return this.atBranch(actor, where, "part.stock_set", (part, stock, now) => {
      const fell = stock.setReorder(
        {
          reorderLevel: input.reorderLevel,
          reorderQty: input.reorderQty,
          location: input.location === undefined ? stock.snapshot().location : input.location,
        },
        now,
      );
      return Promise.resolve({ fell, part });
    });
  }

  /** Stock already on the shelf when the business starts counting (against equity). */
  opening(
    actor: Principal,
    where: Where,
    input: Readonly<{ quantity: number; unitCost: string }>,
  ): Promise<StockView> {
    return this.atBranch(actor, where, "part.opening", async (part, stock, now, currency) => {
      const change = stock.receive(input.quantity, this.minor(input.unitCost, currency), now);
      const move = await this.move(actor, where, "opening", change, now, {});
      await this.post(actor.userId, move.id, "part_opening", `Opening stock of ${label(part)}`, [
        debit(change.valueMinor, {
          accountId: (await this.accounts())("parts_inventory"),
          branchId: where.branchId,
        }),
        credit(change.valueMinor, {
          accountId: (await this.accounts())("equity"),
          branchId: where.branchId,
        }),
      ]);
      return { fell: change.fellBelow, part };
    });
  }

  /**
   * Bought for stock: in at its cost, and an expense to the supplier in the stock category (the
   * inventory, not a cost yet), paid like any other expense.
   */
  receive(
    actor: Principal,
    where: Where,
    input: Readonly<{
      quantity: number;
      unitCost: string;
      supplierId: string;
      reference?: string | null;
      taxCode?: string | null;
    }>,
  ): Promise<StockView & Readonly<{ expenseId: string }>> {
    const { deps } = this;
    let expenseId = "";
    return this.atBranch(actor, where, "part.received", async (part, stock, now, currency) => {
      if (!(await deps.parts.supplierExists(input.supplierId)))
        throw new PartRuleError("That supplier does not exist");
      const change = stock.receive(input.quantity, this.minor(input.unitCost, currency), now);
      const category = (await deps.reference.expenseCategories()).find(
        (c) => c.code === STOCK_CATEGORY,
      );
      if (category === undefined || !category.active)
        throw new PartRuleError(`There is no active "${STOCK_CATEGORY}" expense category`);
      const moveId = deps.ids.next();
      const expense = await deps.expenses.draftFor(
        actor.userId,
        {
          categoryId: category.id,
          description: `${change.quantity} × ${label(part)} for stock`.slice(0, 300),
          branchId: where.branchId,
          expenseDate: await deps.calendar.today(),
          payeeType: "supplier",
          payeeId: input.supplierId,
          amount: Money.ofMinor(change.valueMinor, currency).toDecimalString(),
          reference: input.reference ?? null,
          ...(input.taxCode === undefined ? {} : { taxCode: input.taxCode }),
        },
        where.branchId,
        { type: "part_receipt", id: moveId },
      );
      await deps.expenses.submitLoaded(expense, actor.userId, { skipReceiptRule: true });
      expenseId = expense.id;
      await this.move(actor, where, "receipt", change, now, {
        id: moveId,
        supplierId: input.supplierId,
        expenseId: expense.id,
        reference: input.reference?.trim() || null,
      });
      return { fell: change.fellBelow, part };
    }).then((view) => ({ ...view, expenseId }));
  }

  /** A count: the stock set to what is on the shelf, the difference to stock adjustments. */
  count(
    actor: Principal,
    where: Where,
    input: Readonly<{ counted: number; reason: string; unitCost?: string }>,
  ): Promise<StockView> {
    return this.atBranch(actor, where, "part.counted", async (part, stock, now, currency) => {
      const reason = input.reason.trim();
      if (reason.length < 3) throw new PartRuleError("Say why the stock is adjusted");
      const before = stock.snapshot();
      const delta = Math.round((input.counted - before.onHand) * 100) / 100;
      if (input.counted < 0) throw new PartRuleError("A count is 0 or more");
      if (delta === 0) throw new PartRuleError(`${label(part)}: the count matches the stock`);
      const change =
        delta > 0
          ? stock.receive(
              delta,
              input.unitCost === undefined
                ? before.avgCostMinor
                : this.minor(input.unitCost, currency),
              now,
            )
          : stock.take(-delta, label(part), now);
      const move = await this.move(actor, where, "adjustment", change, now, { reason });
      const accounts = await this.accounts();
      const value = Math.abs(change.valueMinor);
      const inventory = { accountId: accounts("parts_inventory"), branchId: where.branchId };
      const adjustments = { accountId: accounts("stock_adjustments"), branchId: where.branchId };
      await this.post(
        actor.userId,
        move.id,
        "part_adjustment",
        `Stock count of ${label(part)}: ${reason}`,
        delta > 0
          ? [debit(value, inventory), credit(value, adjustments)]
          : [debit(value, adjustments), credit(value, inventory)],
      );
      return { fell: change.fellBelow, part };
    });
  }

  /** From one branch to another at the sending branch's average cost. */
  transfer(
    actor: Principal,
    input: Readonly<{
      partId: string;
      fromBranchId: string;
      toBranchId: string;
      quantity: number;
      reason?: string | null;
    }>,
  ): Promise<readonly [StockView, StockView]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (input.fromBranchId === input.toBranchId)
        throw new PartRuleError("Transfer to another branch");
      for (const b of [input.fromBranchId, input.toBranchId])
        await deps.vehicleAccess.branch(actor, "parts.manage", b);
      const part = await this.part(input.partId);
      const now = deps.clock.now();
      const transferId = deps.ids.next();
      // Lock in a fixed order so two transfers the other way cannot deadlock.
      const [first, second] = [input.fromBranchId, input.toBranchId].sort();
      const locked = new Map<string, Stock>();
      for (const b of [first!, second!]) locked.set(b, await deps.parts.lockStock(part.id, b));
      const from = locked.get(input.fromBranchId)!;
      const to = locked.get(input.toBranchId)!;
      const out = from.take(input.quantity, label(part), now);
      const into = to.receive(input.quantity, out.unitCostMinor, now);
      const reason = input.reason?.trim() || null;
      const fromWhere = { partId: part.id, branchId: input.fromBranchId };
      const toWhere = { partId: part.id, branchId: input.toBranchId };
      await deps.parts.saveStock(from);
      await deps.parts.saveStock(to);
      await this.move(actor, fromWhere, "transfer_out", out, now, { transferId, reason });
      await this.move(actor, toWhere, "transfer_in", into, now, { transferId, reason });
      const accounts = await this.accounts();
      await this.post(actor.userId, transferId, "part_transfer", `Transfer of ${label(part)}`, [
        debit(into.valueMinor, {
          accountId: accounts("parts_inventory"),
          branchId: input.toBranchId,
        }),
        credit(into.valueMinor, {
          accountId: accounts("parts_inventory"),
          branchId: input.fromBranchId,
        }),
      ]);
      if (out.fellBelow) await this.alert(part, from);
      await this.audit(actor, "part.transferred", part.id, null, {
        ...input,
        transferId,
      });
      const currency = await this.currency();
      const rows = await deps.parts.stockOf(part.id, [input.fromBranchId, input.toBranchId]);
      const view = (b: string) =>
        stockView(
          rows.find((r) => r.stock.snapshot().branchId === b)!,
          currency,
        );
      return [view(input.fromBranchId), view(input.toBranchId)] as const;
    });
  }

  moves(
    actor: Principal,
    query: Readonly<{
      partId?: string;
      branchId?: string;
      workOrderId?: string;
      before?: string;
      limit: number;
    }>,
  ): Promise<MoveView[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (query.branchId !== undefined)
        await deps.vehicleAccess.branch(actor, "maintenance.view", query.branchId);
      const moves = await deps.parts.moves({
        branchIds: deps.vehicleAccess.branchesFor(actor, "maintenance.view"),
        ...(query.partId === undefined ? {} : { partId: query.partId }),
        ...(query.branchId === undefined ? {} : { branchId: query.branchId }),
        ...(query.workOrderId === undefined ? {} : { workOrderId: query.workOrderId }),
        ...(query.before === undefined ? {} : { beforeId: query.before }),
        limit: query.limit,
      });
      const currency = await this.currency();
      const m = (minor: number) => Money.ofMinor(minor, currency).toJSON();
      return moves.map(({ unitCostMinor, valueMinor, avgCostAfter, ...rest }) => ({
        ...rest,
        unitCost: m(unitCostMinor),
        value: m(valueMinor),
        avgCostAfter: m(avgCostAfter),
      }));
    });
  }

  // --- for work orders (no permission of their own, inside the caller's unit of work) ---

  /** A catalogue part's unit cost on a work order at the branch: its average cost there. */
  async priceFor(partId: string, branchId: string): Promise<number> {
    const part = await this.deps.parts.get(partId);
    if (part === null || !part.snapshot().active)
      throw new PartRuleError("A part named is not in the catalogue");
    const cost = await this.deps.parts.costAt(partId, branchId);
    if (cost === null)
      throw new PartRuleError(`${label(part)} has never been stocked at the work order's branch`);
    return cost;
  }

  /**
   * Issues the order's catalogue parts from its branch's stock at the average cost and posts
   * their cost (the maintenance category's account, or vehicle expenses) out of the inventory.
   * Returns each line's unit cost as issued.
   */
  async issueFor(order: WorkOrder, userId: string): Promise<ReadonlyMap<string, number>> {
    const { deps } = this;
    const p = order.snapshot();
    const costs = new Map<string, number>();
    const stockLines = p.lines.filter((l) => l.partId !== null);
    if (stockLines.length === 0) return costs;
    const now = deps.clock.now();
    const actor = { userId };
    let total = 0;
    // Lock each part's stock once, in a fixed order.
    const ids = [...new Set(stockLines.map((l) => l.partId!))].sort();
    for (const partId of ids) {
      const part = await this.part(partId);
      const stock = await deps.parts.lockStock(partId, p.branchId);
      for (const line of stockLines.filter((l) => l.partId === partId)) {
        const change = stock.take(line.quantity, label(part), now);
        costs.set(line.id, change.unitCostMinor);
        total += -change.valueMinor;
        await this.move(actor, { partId, branchId: p.branchId }, "issue", change, now, {
          workOrderId: p.id,
          reference: p.number,
        });
        if (change.fellBelow) await this.alert(part, stock);
      }
      await deps.parts.saveStock(stock);
    }
    if (total > 0) {
      const accounts = await this.accounts();
      const { maintenanceCategoryCode } = await deps.expenseSettings.get();
      const category = (await deps.reference.expenseCategories()).find(
        (c) => c.code === maintenanceCategoryCode,
      );
      await this.post(userId, p.id, "work_order", `Parts from stock for work order ${p.number}`, [
        debit(total, {
          accountId: category?.ledgerAccountId ?? accounts("vehicle_expenses"),
          branchId: p.branchId,
          vehicleId: p.vehicleId,
        }),
        credit(total, { accountId: accounts("parts_inventory"), branchId: p.branchId }),
      ]);
    }
    return costs;
  }

  // --- helpers ---

  /** A stock move at one branch, the stock saved and an alert when it has just gone low. */
  private atBranch(
    actor: Principal,
    where: Where,
    action: string,
    run: (
      part: Part,
      stock: Stock,
      now: Date,
      currency: string,
    ) => Promise<Readonly<{ fell: boolean; part: Part }>>,
  ): Promise<StockView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      await deps.vehicleAccess.branch(actor, "parts.manage", where.branchId);
      const part = await this.part(where.partId);
      if (!part.snapshot().active) throw new PartRuleError(`${label(part)} is no longer stocked`);
      const stock = await deps.parts.lockStock(part.id, where.branchId);
      const before = stock.snapshot();
      const currency = await this.currency();
      const { fell } = await run(part, stock, deps.clock.now(), currency);
      await deps.parts.saveStock(stock);
      if (fell) await this.alert(part, stock);
      await this.audit(actor, action, part.id, stockAudit(before), stockAudit(stock.snapshot()));
      const rows = await deps.parts.stockOf(part.id, [where.branchId]);
      return stockView(rows[0]!, currency);
    });
  }

  private async move(
    actor: Readonly<{ userId: string }>,
    where: Where,
    kind: MoveKind,
    change: StockChange,
    now: Date,
    extra: Partial<PartMove>,
  ): Promise<PartMove> {
    const move: PartMove = {
      id: this.deps.ids.next(),
      partId: where.partId,
      branchId: where.branchId,
      kind,
      quantity: change.quantity,
      unitCostMinor: change.unitCostMinor,
      valueMinor: change.valueMinor,
      onHandAfter: change.onHandAfter,
      avgCostAfter: change.avgCostAfter,
      workOrderId: null,
      supplierId: null,
      expenseId: null,
      transferId: null,
      reference: null,
      reason: null,
      createdBy: actor.userId,
      createdAt: now,
      ...extra,
    };
    await this.deps.parts.addMove(move);
    return move;
  }

  private async post(
    userId: string,
    sourceId: string,
    sourceType: string,
    description: string,
    lines: readonly JournalLine[],
  ): Promise<void> {
    if (lines.every((l) => l.debitMinor === 0 && l.creditMinor === 0)) return;
    await this.deps.posting.post(
      journal({
        date: await this.deps.calendar.today(),
        description: description.slice(0, 300),
        source: { type: sourceType, id: sourceId },
        reversesId: null,
        lines,
      }),
      userId,
    );
  }

  /** Staff who manage parts at the branch are told once each time it goes low. */
  private async alert(part: Part, stock: Stock): Promise<void> {
    const { deps } = this;
    const s = stock.snapshot();
    const settings = await deps.settings.get();
    if (!settings.rules.parts_reorder.enabled) return;
    const p = part.snapshot();
    await deps.notifier.staff(settings, {
      rule: "parts_reorder",
      permission: "parts.manage",
      branchId: s.branchId,
      dedupeKey: `parts_reorder:${s.id}:${s.belowSince?.toISOString() ?? ""}`,
      title: `${p.name} is low: ${s.onHand} left`,
      body: `${p.name} (${p.sku}) is down to ${s.onHand} ${p.unit}, at or below the reorder level of ${s.reorderLevel}.${s.reorderQty === null ? "" : ` Order ${s.reorderQty}.`}`,
      severity: s.onHand === 0 ? "critical" : "warning",
      data: { partId: p.id, branchId: s.branchId },
    });
  }

  private async part(id: string): Promise<Part> {
    const part = await this.deps.parts.get(id);
    if (part === null) throw new PartNotFoundError();
    return part;
  }

  private assertManager(actor: Principal): void {
    const branches = this.deps.vehicleAccess.branchesFor(actor, "parts.manage");
    if (branches !== "all" && branches.length === 0)
      throw new PermissionDeniedError("parts.manage");
  }

  private minor(amount: string, currency: string): number {
    return Money.parse(amount, currency).amountMinor;
  }

  private async currency(): Promise<string> {
    return (await this.deps.organisation.get()).baseCurrency;
  }

  private accounts() {
    return this.deps.posting.accounts();
  }

  private async audit(
    actor: Readonly<{ userId: string }>,
    action: string,
    partId: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: "part",
      entityId: partId,
      before,
      after,
    });
  }
}

function fits(list: readonly Readonly<{ make: string; model?: string | null }>[]) {
  return list.map((f) => ({ make: f.make, model: f.model ?? null }));
}

const label = (part: Part) => `${part.snapshot().name} (${part.snapshot().sku})`;

function stockAudit(s: StockProps) {
  return {
    branchId: s.branchId,
    onHand: s.onHand,
    avgCostMinor: s.avgCostMinor,
    reorderLevel: s.reorderLevel,
  };
}

function stockView(r: StockRow, currency: string): StockView {
  const { avgCostMinor, ...s } = r.stock.snapshot();
  const m = (minor: number) => Money.ofMinor(minor, currency).toJSON();
  return {
    ...s,
    sku: r.sku,
    name: r.name,
    unit: r.unit,
    branchName: r.branchName,
    avgCost: m(avgCostMinor),
    value: m(Math.round(s.onHand * avgCostMinor)),
    low: r.stock.low,
  };
}
