import { pageOf, pageWindow, type Page } from "../../dto/Page.js";
import {
  AGEING_BUCKETS,
  StockRuleError,
  StockUnit,
  ageingBucket,
  consignorPayout,
  daysInStock,
  marginOf,
  type AgeingBucket,
  type Consignment,
  type EntryStatus,
  type StockSource,
  type StockStatus,
  type StockTerms,
} from "../../../domain/dealer/StockUnit.js";
import { StockTally, type TalliedUnit } from "../../../domain/dealer/StockTally.js";
import { StockTransferBatch } from "../../../domain/dealer/StockTransferBatch.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import type { Vehicle, VehicleUsage } from "../../../domain/vehicles/Vehicle.js";
import type { VehicleStatus } from "../../../domain/vehicles/VehicleStatus.js";
import type { Principal } from "../../authorization/Principal.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type {
  BatchVehicle,
  IDealerStock,
  PriceChangeRecord,
  StockRecord,
  StockSpend,
  StockTransfer,
  StockTransferBatchRecord,
  StockVehicle,
} from "../../ports/IDealerStock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { DocumentNumbering } from "../reference/DocumentNumbering.js";
import { recordUserAction } from "../reference/userAudit.js";
import { VehicleNotFoundError } from "../vehicles/VehicleAccess.js";
import type { VehicleRegistry } from "../vehicles/VehicleRegistry.js";

export class StockNotFoundError extends ApplicationError {
  readonly code = "STOCK_NOT_FOUND";
  constructor() {
    super("That vehicle is not in dealer stock");
  }
}

export class StockTransferNotFoundError extends ApplicationError {
  readonly code = "STOCK_TRANSFER_NOT_FOUND";
  constructor() {
    super("No such stock transfer");
  }
}

/** On the lot and not held by a deal: what a transfer may pick. */
const TRANSFERABLE: readonly StockStatus[] = ["incoming", "reconditioning", "ready", "listed"];
const ON_THE_LOT: readonly StockStatus[] = [...TRANSFERABLE, "reserved"];

/** The vehicle states a vehicle can be in when it enters stock. */
const ENTERS_FROM: readonly VehicleStatus[] = [
  "available",
  "reconditioning",
  "for_sale",
  "in_maintenance",
];
/** The vehicle states stock moves between; a vehicle elsewhere (in the workshop …) stays put. */
const STOCK_CONTROLLED: readonly VehicleStatus[] = ["available", "reconditioning", "for_sale"];
const REF_TYPE = "dealer_stock";

export type ConsignmentInput = Readonly<{
  consignorId: string;
  terms: "fixed" | "commission";
  payout?: string | null;
  commissionRate?: string | null;
}>;

export type StockTermsInput = Readonly<{
  holdingCostPerDay?: string;
  consignment?: ConsignmentInput | null;
  notes?: string | null;
}>;

export type AddStockInput = StockTermsInput &
  Readonly<{
    vehicleId: string;
    source: StockSource;
    status?: EntryStatus;
    stockedOn?: string;
    askingPrice?: string | null;
    minimumPrice?: string | null;
  }>;

export type PricingInput = Readonly<{
  askingPrice: string | null;
  /** Omitted: the minimum stays. */
  minimumPrice?: string | null;
  reason?: string | null;
}>;

export type StockQuery = Readonly<{
  branchId?: string;
  statuses?: readonly StockStatus[];
  sources?: readonly StockSource[];
  make?: string;
  model?: string;
  yearFrom?: number;
  yearTo?: number;
  priceFrom?: string;
  priceTo?: string;
  minDays?: number;
  consignorId?: string;
  page: number;
  pageSize: number;
}>;

/** What the vehicle has cost the business so far (with `dealer.stock.cost.view`). */
export type StockCost = Readonly<{
  acquisition: MoneyJson;
  reconditioning: MoneyJson;
  holding: MoneyJson;
  /** A consignment: what the consignor gets at the asking price; null without one. */
  consignorPayout: MoneyJson | null;
  total: MoneyJson;
}>;

export type StockView = Readonly<{
  vehicleId: string;
  vehicle: Omit<StockVehicle, "acquisitionCostMinor">;
  status: StockStatus;
  source: StockSource;
  stockedOn: string;
  daysInStock: number;
  ageing: AgeingBucket;
  askingPrice: MoneyJson | null;
  holdingCostPerDay: MoneyJson;
  consignment:
    | (Omit<Consignment, "payoutMinor"> &
        Readonly<{ consignorName: string | null; payout: MoneyJson | null }>)
    | null;
  listedOn: string | null;
  withdrawnOn: string | null;
  withdrawReason: string | null;
  soldOn: string | null;
  deliveredOn: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Only with `dealer.stock.cost.view`. */
  minimumPrice?: MoneyJson | null;
  cost?: StockCost;
  margin?: Readonly<{ amount: MoneyJson; percent: string | null }> | null;
}>;

export type PriceChangeView = Readonly<{
  id: string;
  askingPrice: MoneyJson | null;
  previousAskingPrice: MoneyJson | null;
  /** Only with `dealer.stock.cost.view`. */
  minimumPrice?: MoneyJson | null;
  previousMinimumPrice?: MoneyJson | null;
  reason: string | null;
  changedBy: string | null;
  changedAt: Date;
}>;

type BucketSummary = Readonly<{ count: number; asking: MoneyJson; cost?: MoneyJson }>;

export type AgeingSummary = Readonly<{
  asOf: string;
  buckets: Readonly<Record<AgeingBucket, BucketSummary>>;
  total: BucketSummary;
  averageDays: number | null;
  /** Stock valuation (docs/14): the same figures by stock status, source, make and branch. */
  byStatus: readonly (BucketSummary & Readonly<{ status: StockStatus }>)[];
  bySource: readonly (BucketSummary & Readonly<{ source: StockSource }>)[];
  byMake: readonly (BucketSummary & Readonly<{ make: string }>)[];
  byBranch: readonly (BucketSummary & Readonly<{ branchId: string }>)[];
}>;

export const SUMMARY_GROUPS = ["make", "model", "year"] as const;
export type SummaryGroup = (typeof SUMMARY_GROUPS)[number];

export type StockSummaryQuery = Readonly<{
  branchId?: string;
  /** `model` (the default): make and model; `year`: make, model and year. */
  groupBy?: SummaryGroup;
  /** Statuses on the lot to count; all of them when omitted. */
  statuses?: readonly StockStatus[];
  make?: string;
  model?: string;
}>;

/** Figures of a line or the total, each over the units that have it (decision 541). */
export type StockFigures = Readonly<{
  units: number;
  priced: number;
  unpriced: number;
  /** Asking value of the priced units. */
  asking: MoneyJson;
  averageAsking: MoneyJson | null;
  /** The rest only with `dealer.stock.cost.view`: units whose cost is counted, … */
  costed?: number;
  /** … acquisition, reconditioning, holding and consignor payout … */
  cost?: MoneyJson;
  averageCost?: MoneyJson | null;
  /** … asking less cost over the units with both, and that as a percentage of their asking. */
  profit?: MoneyJson;
  marginPercent?: string | null;
}>;

export type StockSummaryLine = StockFigures &
  Readonly<{
    make: string;
    /** Absent when grouped by make. */
    model?: string;
    /** Only when grouped by year. */
    year?: number | null;
  }>;

export type StockSummary = Readonly<{
  asOf: string;
  groupBy: SummaryGroup;
  lines: readonly StockSummaryLine[];
  total: StockFigures;
}>;

/** Which vehicles a transfer sends: named, or so many of a model, oldest stock first. */
export type TransferPick = Readonly<{
  fromBranchId: string;
  make: string;
  model: string;
  year?: number;
  quantity: number;
}>;

export type BatchTransferInput = Readonly<{
  branchId: string;
  reason: string;
  transferredOn?: string;
  vehicleIds?: readonly string[];
  pick?: TransferPick;
}>;

export type TransferBatchView = StockTransferBatchRecord &
  Readonly<{ vehicles: readonly BatchVehicle[] }>;

export type TransferBatchQuery = Readonly<{
  branchId?: string;
  dateFrom?: string;
  dateTo?: string;
  page: number;
  pageSize: number;
}>;

type Context = Readonly<{
  base: string;
  today: string;
  recoverTax: boolean;
  /** Branches whose stock shows cost, minimum price and margin. */
  costReach: "all" | readonly string[];
}>;

/**
 * Dealer stock (docs/10 §2): vehicles held for sale with their stock status kept in step with the
 * vehicle's, asking and minimum prices with their history, cost and margin shown only with
 * `dealer.stock.cost.view`, days in stock and ageing, holding cost, consignment terms and
 * branch-to-branch transfers (decisions 429–436).
 */
export class DealerStock {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      stock: IDealerStock;
      vehicles: IVehicleRepository;
      registry: VehicleRegistry;
      organisation: IOrganisationSettings;
      scope: BranchScope;
      calendar: TenantCalendar;
      numbering: DocumentNumbering;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  list(actor: Principal, query: StockQuery): Promise<Page<StockView>> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (query.branchId !== undefined)
        await deps.scope.branch(actor, "dealer.stock.list", query.branchId);
      const context = await this.context(actor);
      const records = await deps.stock.page({
        branchIds: deps.scope.branchesFor(actor, "dealer.stock.list"),
        ...(query.branchId === undefined ? {} : { branchId: query.branchId }),
        ...(query.statuses === undefined ? {} : { statuses: query.statuses }),
        ...(query.sources === undefined ? {} : { sources: query.sources }),
        ...(query.make === undefined ? {} : { make: query.make }),
        ...(query.model === undefined ? {} : { model: query.model }),
        ...(query.yearFrom === undefined ? {} : { yearFrom: query.yearFrom }),
        ...(query.yearTo === undefined ? {} : { yearTo: query.yearTo }),
        ...(query.priceFrom === undefined
          ? {}
          : { priceFromMinor: Money.parse(query.priceFrom, context.base).amountMinor }),
        ...(query.priceTo === undefined
          ? {}
          : { priceToMinor: Money.parse(query.priceTo, context.base).amountMinor }),
        ...(query.minDays === undefined
          ? {}
          : { stockedOnOrBefore: shift(context.today, -query.minDays) }),
        ...(query.consignorId === undefined ? {} : { consignorId: query.consignorId }),
        ...pageWindow(query),
      });
      const spend = await this.spend(records.rows, context);
      return pageOf(query, records, (r) => this.view(r, context, spend.get(r.unit.vehicleId)));
    });
  }

  get(actor: Principal, vehicleId: string): Promise<StockView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      await this.reach(actor, vehicleId, "dealer.stock.view");
      return this.present(actor, vehicleId);
    });
  }

  /**
   * Puts a vehicle into stock (usage `stock`; a consignment becomes `consigned`), or back into
   * stock after it was withdrawn or returned; the vehicle follows the entry status.
   */
  add(actor: Principal, input: AddStockInput): Promise<StockView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const vehicle = await deps.vehicles.lockById(input.vehicleId);
      if (
        vehicle === null ||
        vehicle.deleted ||
        !deps.scope.can(actor, "dealer.stock.create", vehicle.branchId)
      )
        throw new VehicleNotFoundError();
      if (!ENTERS_FROM.includes(vehicle.status))
        throw new StockRuleError(
          `The vehicle is ${vehicle.status.replaceAll("_", " ")}: it cannot go into stock`,
        );
      const context = await this.context(actor);
      const stockedOn = input.stockedOn ?? context.today;
      const status =
        input.status ?? (vehicle.status === "reconditioning" ? "reconditioning" : "ready");
      const terms = await this.terms(input, context.base, null);
      const now = deps.clock.now();
      const existing = await deps.stock.lock(vehicle.id);
      let unit: StockUnit;
      if (existing === null) {
        unit = StockUnit.add({
          vehicleId: vehicle.id,
          source: input.source,
          status,
          stockedOn,
          terms,
          createdBy: actor.userId,
          now,
        });
        await deps.stock.insert(unit);
      } else {
        unit = existing;
        unit.restock({ source: input.source, status, stockedOn, terms }, now);
        await deps.stock.update(unit);
      }
      vehicle.updateDetails(
        {
          usage: "stock",
          ...(input.source === "consignment" ? { ownershipType: "consigned" as const } : {}),
        },
        now,
        Number(context.today.slice(0, 4)),
      );
      await deps.vehicles.save(vehicle);
      await this.follow(actor, vehicle, status === "ready" ? "available" : "reconditioning", {
        reason: "Taken into dealer stock",
      });
      if (input.askingPrice !== undefined || input.minimumPrice !== undefined)
        await this.reprice(actor, unit, context.base, {
          askingPrice: input.askingPrice ?? null,
          minimumPrice: input.minimumPrice ?? null,
          reason: "Priced on entry",
        });
      await this.audit(actor, existing === null ? "stock.added" : "stock.restocked", unit);
      return this.present(actor, vehicle.id);
    });
  }

  /** Holding cost per day, consignment terms and notes. */
  setTerms(actor: Principal, vehicleId: string, input: StockTermsInput): Promise<StockView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const { unit } = await this.reach(actor, vehicleId, "dealer.stock.update", true);
      const { base } = await this.context(actor);
      unit.setTerms(await this.terms(input, base, unit), deps.clock.now());
      await deps.stock.update(unit);
      await this.audit(actor, "stock.terms_changed", unit);
      return this.present(actor, vehicleId);
    });
  }

  markReady(actor: Principal, vehicleId: string): Promise<StockView> {
    return this.step(actor, vehicleId, "dealer.stock.update", "stock.ready", (unit, vehicle) => {
      unit.markReady(this.deps.clock.now());
      return this.follow(actor, vehicle, "available", { reason: "Ready for sale" });
    });
  }

  recondition(actor: Principal, vehicleId: string): Promise<StockView> {
    return this.step(
      actor,
      vehicleId,
      "dealer.stock.update",
      "stock.reconditioning",
      (unit, vehicle) => {
        unit.recondition(this.deps.clock.now());
        return this.follow(actor, vehicle, "reconditioning", { reason: "Reconditioning" });
      },
    );
  }

  /** New asking and minimum prices, logged in the price history. */
  price(actor: Principal, vehicleId: string, input: PricingInput): Promise<StockView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const { unit } = await this.reach(actor, vehicleId, "dealer.stock.price.manage", true);
      const { base } = await this.context(actor);
      await this.reprice(actor, unit, base, input);
      await this.audit(actor, "stock.priced", unit, { reason: input.reason ?? null });
      return this.present(actor, vehicleId);
    });
  }

  /** On sale at its asking price: the vehicle goes for sale. */
  listForSale(actor: Principal, vehicleId: string): Promise<StockView> {
    return this.step(
      actor,
      vehicleId,
      "dealer.stock.list_for_sale",
      "stock.listed",
      async (unit, vehicle) => {
        unit.list(await this.deps.calendar.today(), this.deps.clock.now());
        if (vehicle.status !== "for_sale")
          await this.deps.registry.moveByModule(vehicle, "for_sale", {
            ref: { type: REF_TYPE, id: vehicle.id },
            reason: "Listed for sale",
            userId: actor.userId,
          });
      },
    );
  }

  unlist(actor: Principal, vehicleId: string): Promise<StockView> {
    return this.step(
      actor,
      vehicleId,
      "dealer.stock.list_for_sale",
      "stock.unlisted",
      (unit, vehicle) => {
        unit.unlist(this.deps.clock.now());
        return this.follow(actor, vehicle, "available", { reason: "Taken off sale" });
      },
    );
  }

  /** Out of stock: the vehicle is available again for the use given (default fleet). */
  withdraw(
    actor: Principal,
    vehicleId: string,
    input: Readonly<{ reason: string; usage?: Exclude<VehicleUsage, "stock"> }>,
  ): Promise<StockView> {
    const { deps } = this;
    return this.step(
      actor,
      vehicleId,
      "dealer.stock.withdraw",
      "stock.withdrawn",
      async (unit, vehicle) => {
        const today = await deps.calendar.today();
        unit.withdraw(input.reason, today, deps.clock.now());
        vehicle.updateDetails(
          { usage: input.usage ?? "fleet" },
          deps.clock.now(),
          Number(today.slice(0, 4)),
        );
        await deps.vehicles.save(vehicle);
        await this.follow(actor, vehicle, "available", {
          reason: `Withdrawn from stock: ${input.reason.trim()}`,
        });
      },
      { reason: input.reason },
    );
  }

  /** Moves a vehicle on the lot to another branch, with a transfer record. */
  transfer(
    actor: Principal,
    vehicleId: string,
    input: Readonly<{ branchId: string; reason: string; transferredOn?: string }>,
  ): Promise<StockView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const { unit, vehicle } = await this.reach(actor, vehicleId, "dealer.stock.transfer", true);
      await deps.scope.branch(actor, "dealer.stock.transfer", input.branchId);
      unit.assertTransferable();
      if (vehicle.branchId === input.branchId)
        throw new StockRuleError("The vehicle is already there");
      if (input.reason.trim().length < 3) throw new StockRuleError("Give a reason");
      await this.send(actor, vehicle, {
        toBranchId: input.branchId,
        transferredOn: input.transferredOn ?? (await deps.calendar.today()),
        reason: input.reason.trim(),
        batch: null,
        now: deps.clock.now(),
      });
      return this.present(actor, vehicleId);
    });
  }

  /**
   * Sends several stock vehicles from one branch to another under one reference (decision 542):
   * the vehicles named, or `pick.quantity` of a make and model (and year) at the sending branch,
   * oldest stock first. All of them go or none does; each keeps its own transfer record.
   */
  transferMany(actor: Principal, input: BatchTransferInput): Promise<TransferBatchView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if ((input.vehicleIds === undefined) === (input.pick === undefined))
        throw new StockRuleError("Name the vehicles or say how many of a model to send");
      await deps.scope.branch(actor, "dealer.stock.transfer", input.branchId);
      const ids =
        input.pick === undefined ? [...input.vehicleIds!] : await this.pick(actor, input.pick);
      StockTransferBatch.assertCount(ids.length);
      // Locked in one order, so two transfers sharing vehicles cannot deadlock.
      const locked = new Map<string, Vehicle>();
      for (const id of [...new Set(ids)].sort()) {
        const { unit, vehicle } = await this.reach(actor, id, "dealer.stock.transfer", true);
        try {
          unit.assertTransferable();
        } catch (error) {
          if (error instanceof StockRuleError)
            throw new StockRuleError(`${vehicle.snapshot().code}: ${error.message}`);
          throw error;
        }
        locked.set(id, vehicle);
      }
      const from = locked.get(ids[0]!)!.branchId;
      if ([...locked.values()].some((v) => v.branchId !== from))
        throw new StockRuleError(
          "The vehicles are in different branches: send one branch at a time",
        );
      if (input.pick !== undefined && from !== input.pick.fromBranchId)
        throw new StockRuleError("A vehicle picked has just left that branch: try again");
      const now = deps.clock.now();
      const transferredOn = input.transferredOn ?? (await deps.calendar.today());
      if (from === input.branchId) throw new StockRuleError("The vehicles are already there");
      const batch = StockTransferBatch.create({
        id: deps.ids.next(),
        reference: await deps.numbering.next("stock_transfer", now),
        fromBranchId: from,
        toBranchId: input.branchId,
        transferredOn,
        reason: input.reason,
        vehicleIds: ids,
        transferredBy: actor.userId,
        createdAt: now,
      });
      const b = batch.snapshot();
      const record: StockTransferBatchRecord = {
        id: b.id,
        reference: b.reference,
        fromBranchId: b.fromBranchId,
        toBranchId: b.toBranchId,
        transferredOn: b.transferredOn,
        reason: b.reason,
        vehicleCount: b.vehicleIds.length,
        transferredBy: b.transferredBy,
        createdAt: b.createdAt,
      };
      await deps.stock.addTransferBatch(record);
      for (const id of batch.vehicleIds)
        await this.send(actor, locked.get(id)!, {
          toBranchId: b.toBranchId,
          transferredOn,
          reason: b.reason,
          batch: record,
          now,
        });
      await recordUserAction(deps, actor.userId, {
        action: "stock.transfer_batch.created",
        entityType: "dealer_stock_transfer_batch",
        entityId: record.id,
        after: {
          reference: record.reference,
          fromBranchId: record.fromBranchId,
          toBranchId: record.toBranchId,
          vehicleCount: record.vehicleCount,
        },
        metadata: { reason: record.reason, vehicleIds: batch.vehicleIds },
      });
      return { ...record, vehicles: await deps.stock.batchVehicles(record.id) };
    });
  }

  /** Transfers of several vehicles leaving or reaching your branches, newest first. */
  transferBatches(
    actor: Principal,
    query: TransferBatchQuery,
  ): Promise<Page<StockTransferBatchRecord>> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (query.branchId !== undefined)
        await deps.scope.branch(actor, "dealer.stock.list", query.branchId);
      const records = await deps.stock.transferBatches({
        branchIds: deps.scope.branchesFor(actor, "dealer.stock.list"),
        ...(query.branchId === undefined ? {} : { branchId: query.branchId }),
        ...(query.dateFrom === undefined ? {} : { dateFrom: query.dateFrom }),
        ...(query.dateTo === undefined ? {} : { dateTo: query.dateTo }),
        ...pageWindow(query),
      });
      return pageOf(query, records);
    });
  }

  /** A transfer of several vehicles, seen from either end. */
  transferBatch(actor: Principal, id: string): Promise<TransferBatchView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const record = await deps.stock.transferBatch(id);
      if (
        record === null ||
        !(
          deps.scope.can(actor, "dealer.stock.view", record.fromBranchId) ||
          deps.scope.can(actor, "dealer.stock.view", record.toBranchId)
        )
      )
        throw new StockTransferNotFoundError();
      return { ...record, vehicles: await deps.stock.batchVehicles(record.id) };
    });
  }

  /**
   * Units on the lot added up by make and model (or make alone, or make, model and year): how
   * many, their asking value and, with `dealer.stock.cost.view`, their cost, profit and margin.
   */
  summary(actor: Principal, query: StockSummaryQuery): Promise<StockSummary> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const groupBy = query.groupBy ?? "model";
      const statuses = query.statuses?.filter((s) => ON_THE_LOT.includes(s)) ?? ON_THE_LOT;
      if (statuses.length === 0)
        throw new StockRuleError("Count statuses on the lot: incoming to reserved");
      const { records, context } = await this.onTheLot(actor, {
        ...(query.branchId === undefined ? {} : { branchId: query.branchId }),
        ...(query.make === undefined ? {} : { make: query.make }),
        ...(query.model === undefined ? {} : { model: query.model }),
        statuses,
      });
      const spend = await this.spend(records, context);
      const withCost = context.costReach === "all" || context.costReach.length > 0;
      const total = new StockTally();
      const lines = new Map<
        string,
        { make: string; model: string; year: number | null; tally: StockTally }
      >();
      for (const r of records) {
        const view = this.view(r, context, spend.get(r.unit.vehicleId));
        const unit: TalliedUnit = {
          askingMinor: view.askingPrice?.amountMinor ?? null,
          costMinor: view.cost?.total.amountMinor ?? null,
        };
        const { make, model, year } = r.vehicle;
        const key = [
          make.trim().toLowerCase(),
          groupBy === "make" ? "" : model.trim().toLowerCase(),
          groupBy === "year" ? String(year) : "",
        ].join("\u0000");
        let line = lines.get(key);
        if (line === undefined)
          lines.set(
            key,
            (line = { make: make.trim(), model: model.trim(), year, tally: new StockTally() }),
          );
        line.tally.add(unit);
        total.add(unit);
      }
      const figures = (tally: StockTally): StockFigures => {
        const t = tally.totals();
        const m = (minor: number) => Money.ofMinor(minor, context.base).toJSON();
        const avg = (minor: number | null) => (minor === null ? null : m(minor));
        return {
          units: t.units,
          priced: t.priced,
          unpriced: t.unpriced,
          asking: m(t.askingMinor),
          averageAsking: avg(t.averageAskingMinor),
          ...(withCost
            ? {
                costed: t.costed,
                cost: m(t.costMinor),
                averageCost: avg(t.averageCostMinor),
                profit: m(t.profitMinor),
                marginPercent: t.marginPercent,
              }
            : {}),
        };
      };
      const sorted = [...lines.values()].sort(
        (a, b) =>
          a.make.localeCompare(b.make) ||
          (groupBy === "make" ? 0 : a.model.localeCompare(b.model)) ||
          (groupBy === "year" ? (b.year ?? -1) - (a.year ?? -1) : 0),
      );
      return {
        asOf: context.today,
        groupBy,
        lines: sorted.map((l) => ({
          make: l.make,
          ...(groupBy === "make" ? {} : { model: l.model }),
          ...(groupBy === "year" ? { year: l.year } : {}),
          ...figures(l.tally),
        })),
        total: figures(total),
      };
    });
  }

  transfers(actor: Principal, vehicleId: string): Promise<StockTransfer[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      await this.reach(actor, vehicleId, "dealer.stock.view");
      return deps.stock.transfers(vehicleId);
    });
  }

  priceHistory(actor: Principal, vehicleId: string): Promise<PriceChangeView[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const { vehicle } = await this.reach(actor, vehicleId, "dealer.stock.view");
      const { base, costReach } = await this.context(actor);
      const showCost = shows(costReach, vehicle.branchId);
      const m = (minor: number | null) =>
        minor === null ? null : Money.ofMinor(minor, base).toJSON();
      return (await deps.stock.priceChanges(vehicleId)).map((c) => ({
        id: c.id,
        askingPrice: m(c.askingPriceMinor),
        previousAskingPrice: m(c.previousAskingMinor),
        ...(showCost
          ? {
              minimumPrice: m(c.minimumPriceMinor),
              previousMinimumPrice: m(c.previousMinimumMinor),
            }
          : {}),
        reason: c.reason,
        changedBy: c.changedBy,
        changedAt: c.changedAt,
      }));
    });
  }

  /** Stock on the lot by days in stock (0–30, 31–60, 61–90, over 90). */
  ageing(actor: Principal, query: Readonly<{ branchId?: string }>): Promise<AgeingSummary> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const { records, context } = await this.onTheLot(actor, {
        ...(query.branchId === undefined ? {} : { branchId: query.branchId }),
        statuses: ON_THE_LOT,
      });
      const spend = await this.spend(records, context);
      type Sum = { count: number; asking: number; cost: number };
      const sums = new Map<string, Sum>(
        [...AGEING_BUCKETS, "total"].map((b) => [b, { count: 0, asking: 0, cost: 0 }]),
      );
      // Groups keep the order they are first met in; makes are sorted below.
      const groups = { status: [], source: [], make: [], branch: [] } as Record<
        "status" | "source" | "make" | "branch",
        string[]
      >;
      let days = 0;
      for (const r of records) {
        const view = this.view(r, context, spend.get(r.unit.vehicleId));
        days += view.daysInStock;
        const keys: [keyof typeof groups, string][] = [
          ["status", view.status],
          ["source", view.source],
          ["make", view.vehicle.make],
          ["branch", view.vehicle.branchId],
        ];
        for (const [group, value] of keys)
          if (!groups[group].includes(value)) groups[group].push(value);
        for (const key of [view.ageing, "total", ...keys.map(([g, v]) => `${g}:${v}`)]) {
          let s = sums.get(key);
          if (s === undefined) sums.set(key, (s = { count: 0, asking: 0, cost: 0 }));
          s.count += 1;
          s.asking += view.askingPrice?.amountMinor ?? 0;
          s.cost += view.cost?.total.amountMinor ?? 0;
        }
      }
      const summary = (key: string): BucketSummary => {
        const s = sums.get(key)!;
        return {
          count: s.count,
          asking: Money.ofMinor(s.asking, context.base).toJSON(),
          ...(context.costReach === "all" || context.costReach.length > 0
            ? { cost: Money.ofMinor(s.cost, context.base).toJSON() }
            : {}),
        };
      };
      return {
        asOf: context.today,
        buckets: Object.fromEntries(AGEING_BUCKETS.map((b) => [b, summary(b)])) as Record<
          AgeingBucket,
          BucketSummary
        >,
        total: summary("total"),
        averageDays: records.length === 0 ? null : Math.round(days / records.length),
        byStatus: groups.status.map((status) => ({
          status: status as StockStatus,
          ...summary(`status:${status}`),
        })),
        bySource: groups.source.map((source) => ({
          source: source as StockSource,
          ...summary(`source:${source}`),
        })),
        byMake: groups.make
          .sort((a, b) => a.localeCompare(b))
          .map((make) => ({ make, ...summary(`make:${make}`) })),
        byBranch: groups.branch.map((branchId) => ({ branchId, ...summary(`branch:${branchId}`) })),
      };
    });
  }

  /** Every unit on the lot in the caller's branches that the filter keeps, oldest first. */
  private async onTheLot(
    actor: Principal,
    filter: Readonly<{
      branchId?: string;
      make?: string;
      model?: string;
      statuses: readonly StockStatus[];
    }>,
  ): Promise<Readonly<{ records: StockRecord[]; context: Context }>> {
    const { deps } = this;
    if (filter.branchId !== undefined)
      await deps.scope.branch(actor, "dealer.stock.list", filter.branchId);
    const context = await this.context(actor);
    const records: StockRecord[] = [];
    for (let after: string | undefined; ;) {
      const page = await deps.stock.list({
        branchIds: deps.scope.branchesFor(actor, "dealer.stock.list"),
        ...filter,
        limit: 500,
        ...(after === undefined ? {} : { afterVehicleId: after }),
      });
      records.push(...page);
      if (page.length < 500) break;
      after = page[page.length - 1]!.unit.vehicleId;
    }
    return { records, context };
  }

  /** The oldest `quantity` transferable units of a model at the sending branch. */
  private async pick(actor: Principal, pick: TransferPick): Promise<string[]> {
    const { deps } = this;
    await deps.scope.branch(actor, "dealer.stock.transfer", pick.fromBranchId);
    StockTransferBatch.assertCount(pick.quantity);
    const records = await deps.stock.list({
      branchIds: deps.scope.branchesFor(actor, "dealer.stock.transfer"),
      branchId: pick.fromBranchId,
      statuses: TRANSFERABLE,
      make: pick.make,
      model: pick.model,
      ...(pick.year === undefined ? {} : { yearFrom: pick.year, yearTo: pick.year }),
      limit: pick.quantity,
    });
    if (records.length < pick.quantity) {
      const what = [pick.year, pick.make, pick.model].filter((p) => p !== undefined).join(" ");
      throw new StockRuleError(
        records.length === 0
          ? `No ${what} at that branch can be transferred`
          : `Only ${records.length} ${what} at that branch can be transferred`,
      );
    }
    return records.map((r) => r.unit.vehicleId);
  }

  /** Moves one vehicle with its transfer record and audit entry. */
  private async send(
    actor: Principal,
    vehicle: Vehicle,
    move: Readonly<{
      toBranchId: string;
      transferredOn: string;
      reason: string;
      batch: StockTransferBatchRecord | null;
      now: Date;
    }>,
  ): Promise<void> {
    const { deps } = this;
    const from = vehicle.branchId;
    vehicle.moveToBranch(move.toBranchId, move.now);
    await deps.vehicles.save(vehicle);
    const transfer: StockTransfer = {
      id: deps.ids.next(),
      vehicleId: vehicle.id,
      fromBranchId: from,
      toBranchId: move.toBranchId,
      transferredOn: move.transferredOn,
      reason: move.reason,
      transferredBy: actor.userId,
      createdAt: move.now,
      batchId: move.batch?.id ?? null,
    };
    await deps.stock.addTransfer(transfer);
    await recordUserAction(deps, actor.userId, {
      action: "stock.transferred",
      entityType: "vehicle",
      entityId: vehicle.id,
      before: { branchId: from },
      after: { branchId: move.toBranchId },
      metadata: {
        reason: transfer.reason,
        transferId: transfer.id,
        ...(move.batch === null
          ? {}
          : { batchId: move.batch.id, batchReference: move.batch.reference }),
      },
    });
  }

  private async step(
    actor: Principal,
    vehicleId: string,
    permission: PermissionKey,
    action: string,
    apply: (unit: StockUnit, vehicle: Vehicle) => Promise<void>,
    metadata?: Readonly<Record<string, unknown>>,
  ): Promise<StockView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const { unit, vehicle } = await this.reach(actor, vehicleId, permission, true);
      await apply(unit, vehicle);
      await deps.stock.update(unit);
      await this.audit(actor, action, unit, metadata);
      return this.present(actor, vehicleId);
    });
  }

  /** Moves the vehicle with its stock status, unless it is somewhere stock does not control. */
  private async follow(
    actor: Principal,
    vehicle: Vehicle,
    to: VehicleStatus,
    params: Readonly<{ reason: string }>,
  ): Promise<void> {
    if (vehicle.status === to || !STOCK_CONTROLLED.includes(vehicle.status)) return;
    await this.deps.registry.moveByModule(vehicle, to, {
      ref: { type: REF_TYPE, id: vehicle.id },
      reason: params.reason,
      userId: actor.userId,
    });
  }

  private async reprice(
    actor: Principal,
    unit: StockUnit,
    base: string,
    input: PricingInput,
  ): Promise<void> {
    const { deps } = this;
    const parse = (amount: string | null) =>
      amount === null ? null : Money.parse(amount, base).amountMinor;
    const minimum =
      input.minimumPrice === undefined
        ? unit.snapshot().minimumPriceMinor
        : parse(input.minimumPrice);
    const now = deps.clock.now();
    const change = unit.price(parse(input.askingPrice), minimum, now);
    await deps.stock.update(unit);
    const reason = input.reason?.trim() ?? "";
    const record: PriceChangeRecord = {
      ...change,
      id: deps.ids.next(),
      vehicleId: unit.vehicleId,
      reason: reason === "" ? null : reason,
      changedBy: actor.userId,
      changedAt: now,
    };
    await deps.stock.addPriceChange(record);
  }

  private async terms(
    input: StockTermsInput,
    base: string,
    current: StockUnit | null,
  ): Promise<StockTerms> {
    const was = current?.snapshot();
    let consignment: Consignment | null = was?.consignment ?? null;
    if (input.consignment !== undefined) {
      const c = input.consignment;
      if (c !== null && !(await this.deps.stock.consignorExists(c.consignorId)))
        throw new StockRuleError("The consignor is not a customer");
      consignment =
        c === null
          ? null
          : {
              consignorId: c.consignorId,
              terms: c.terms,
              payoutMinor:
                c.payout === undefined || c.payout === null
                  ? null
                  : Money.parse(c.payout, base).amountMinor,
              commissionRate: c.commissionRate ?? null,
            };
    }
    return {
      holdingCostPerDayMinor:
        input.holdingCostPerDay === undefined
          ? (was?.holdingCostPerDayMinor ?? 0)
          : Money.parse(input.holdingCostPerDay, base).amountMinor,
      consignment,
      notes: input.notes === undefined ? (was?.notes ?? null) : input.notes,
    };
  }

  private async reach(
    actor: Principal,
    vehicleId: string,
    permission: PermissionKey,
    lock = false,
  ): Promise<Readonly<{ unit: StockUnit; vehicle: Vehicle }>> {
    const { deps } = this;
    const vehicle = lock
      ? await deps.vehicles.lockById(vehicleId)
      : await deps.vehicles.findById(vehicleId);
    if (vehicle === null || vehicle.deleted || !deps.scope.can(actor, permission, vehicle.branchId))
      throw new StockNotFoundError();
    const unit = lock ? await deps.stock.lock(vehicleId) : await deps.stock.get(vehicleId);
    if (unit === null) throw new StockNotFoundError();
    return { unit, vehicle };
  }

  private async present(actor: Principal, vehicleId: string): Promise<StockView> {
    const { deps } = this;
    const record = await deps.stock.record(vehicleId);
    if (record === null) throw new StockNotFoundError();
    const context = await this.context(actor);
    const spend = await this.spend([record], context);
    return this.view(record, context, spend.get(vehicleId));
  }

  /** Spend since stocking, only for the units whose cost the caller sees. */
  private spend(
    records: readonly StockRecord[],
    context: Context,
  ): Promise<Map<string, StockSpend>> {
    const ids = records
      .filter((r) => shows(context.costReach, r.vehicle.branchId))
      .map((r) => r.unit.vehicleId);
    return ids.length === 0
      ? Promise.resolve(new Map<string, StockSpend>())
      : this.deps.stock.spend(ids);
  }

  private async context(actor: Principal): Promise<Context> {
    const { deps } = this;
    return {
      base: (await deps.organisation.currencySettings()).baseCurrency,
      today: await deps.calendar.today(),
      recoverTax: (await deps.organisation.taxSettings()).scheme !== "not_registered",
      costReach: deps.scope.branchesFor(actor, "dealer.stock.cost.view"),
    };
  }

  private view(record: StockRecord, context: Context, spend: StockSpend | undefined): StockView {
    const p = record.unit.snapshot();
    const { acquisitionCostMinor, ...vehicle } = record.vehicle;
    const m = (minor: number) => Money.ofMinor(minor, context.base).toJSON();
    const until = p.soldOn ?? p.withdrawnOn ?? context.today;
    const days = daysInStock(p.stockedOn, until);
    const showCost = shows(context.costReach, record.vehicle.branchId);
    const view: StockView = {
      vehicleId: p.vehicleId,
      vehicle,
      status: p.status,
      source: p.source,
      stockedOn: p.stockedOn,
      daysInStock: days,
      ageing: ageingBucket(days),
      askingPrice: p.askingPriceMinor === null ? null : m(p.askingPriceMinor),
      holdingCostPerDay: m(p.holdingCostPerDayMinor),
      consignment:
        p.consignment === null
          ? null
          : {
              consignorId: p.consignment.consignorId,
              consignorName: record.consignorName,
              terms: p.consignment.terms,
              payout: p.consignment.payoutMinor === null ? null : m(p.consignment.payoutMinor),
              commissionRate: p.consignment.commissionRate,
            },
      listedOn: p.listedOn,
      withdrawnOn: p.withdrawnOn,
      withdrawReason: p.withdrawReason,
      soldOn: p.soldOn,
      deliveredOn: p.deliveredOn,
      notes: p.notes,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
    if (!showCost) return view;
    const acquisition = p.consignment === null ? (acquisitionCostMinor ?? 0) : 0;
    const reconditioning =
      spend === undefined ? 0 : context.recoverTax ? spend.netBaseMinor : spend.amountBaseMinor;
    const holding = days * p.holdingCostPerDayMinor;
    const payout =
      p.consignment === null
        ? null
        : p.consignment.terms === "fixed"
          ? consignorPayout(p.consignment, 0)
          : p.askingPriceMinor === null
            ? null
            : consignorPayout(p.consignment, p.askingPriceMinor);
    const total = acquisition + reconditioning + holding + (payout ?? 0);
    const margin = p.askingPriceMinor === null ? null : marginOf(p.askingPriceMinor, total);
    return {
      ...view,
      minimumPrice: p.minimumPriceMinor === null ? null : m(p.minimumPriceMinor),
      cost: {
        acquisition: m(acquisition),
        reconditioning: m(reconditioning),
        holding: m(holding),
        consignorPayout: payout === null ? null : m(payout),
        total: m(total),
      },
      margin: margin === null ? null : { amount: m(margin.marginMinor), percent: margin.percent },
    };
  }

  private async audit(
    actor: Principal,
    action: string,
    unit: StockUnit,
    metadata?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const p = unit.snapshot();
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: "vehicle",
      entityId: unit.vehicleId,
      after: { status: p.status, source: p.source, stockedOn: p.stockedOn },
      ...(metadata === undefined ? {} : { metadata }),
    });
  }
}

function shows(reach: "all" | readonly string[], branchId: string): boolean {
  return reach === "all" || reach.includes(branchId);
}

function shift(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
