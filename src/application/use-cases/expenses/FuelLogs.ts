import { ExpenseRuleError, type PayeeType } from "../../../domain/expenses/Expense.js";
import { fuelEfficiency, type FuelEfficiency } from "../../../domain/expenses/ExpenseRules.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { Vehicle } from "../../../domain/vehicles/Vehicle.js";
import type { IExpenseRepository } from "../../../domain/repositories/IExpenseRepository.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { FuelLog, IExpenseSettingsStore, IFuelLogs } from "../../ports/IExpenseRecords.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { ITenantReferenceData } from "../../ports/IReferenceData.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { OdometerLog } from "../vehicles/OdometerLog.js";
import type { VehicleAccess } from "../vehicles/VehicleAccess.js";
import { expenseView, type ExpenseView, type Expenses } from "./Expenses.js";

export type FuelInput = Readonly<{
  litres: string;
  amount: string;
  odometer: number;
  fullTank?: boolean;
  filledAt?: Date;
  station?: string | null;
  /** The fuel station as a supplier (else `station` is the payee name). */
  supplierId?: string | null;
  driverId?: string | null;
  notes?: string | null;
}>;

export type FuelLogView = Omit<FuelLog, "amountMinor"> &
  Readonly<{ amount: MoneyJson; pricePerLitre: MoneyJson }>;

export type FuelReport = Readonly<{
  logs: readonly FuelLogView[];
  /** km per litre between full-tank fills; flagged intervals look wrong (siphoning, leaks). */
  efficiency: readonly FuelEfficiency[];
  averageKmPerLitre: number | null;
}>;

/**
 * Fuel logs (docs/06 §7): each fill records litres, amount, station and the odometer (a
 * `fuel` reading, same rules as any reading) and creates the fuel expense for the vehicle,
 * submitted straight away (approval rules apply). Efficiency between full-tank fills shows
 * intervals far below the vehicle's usual consumption.
 */
export class FuelLogs {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      logs: IFuelLogs;
      expenses: Expenses;
      expenseRepository: IExpenseRepository;
      settings: IExpenseSettingsStore;
      reference: ITenantReferenceData;
      vehicles: VehicleAccess;
      odometer: OdometerLog;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  async record(
    actor: Principal,
    vehicleId: string,
    input: FuelInput,
  ): Promise<Readonly<{ log: FuelLogView; expense: ExpenseView }>> {
    const { deps } = this;
    return deps.unitOfWork.run(async () =>
      this.recordLoaded(
        actor.userId,
        await deps.vehicles.reach(actor, vehicleId, "expenses.fuel.record", true),
        input,
        false,
      ),
    );
  }

  /**
   * A driver logs a fill of the vehicle they drive (driver app). Paid by the driver: the business
   * owes them the amount once approved; otherwise the station (fuel float, card) is the payee.
   */
  async recordByDriver(
    userId: string,
    vehicle: Vehicle,
    driverId: string,
    input: Omit<FuelInput, "driverId" | "supplierId"> & Readonly<{ paidByDriver: boolean }>,
  ): Promise<Readonly<{ log: FuelLogView; expense: ExpenseView }>> {
    const { paidByDriver, ...rest } = input;
    return this.deps.unitOfWork.run(() =>
      this.recordLoaded(userId, vehicle, { ...rest, driverId }, paidByDriver),
    );
  }

  private async recordLoaded(
    userId: string,
    vehicle: Vehicle,
    input: FuelInput,
    payDriver: boolean,
  ): Promise<Readonly<{ log: FuelLogView; expense: ExpenseView }>> {
    const { deps } = this;
    const vehicleId = vehicle.id;
    // Within the caller's unit of work.
    const litres = Number(input.litres);
    if (!Number.isFinite(litres) || litres <= 0 || litres > 2_000)
      throw new ExpenseRuleError("Litres are above 0 and at most 2000");
    const { fuelCategoryCode } = await deps.settings.get();
    const category = (await deps.reference.expenseCategories()).find(
      (c) => c.code === fuelCategoryCode,
    );
    if (category === undefined)
      throw new ExpenseRuleError(`There is no "${fuelCategoryCode}" expense category`);
    const now = deps.clock.now();
    const filledAt = input.filledAt ?? now;
    const id = deps.ids.next();
    await deps.odometer.recordFor(
      vehicle,
      { value: input.odometer, readAt: filledAt },
      "fuel",
      id,
      userId,
    );
    const station = input.station?.trim() ?? "";
    const payee: { payeeType?: PayeeType; payeeId?: string; payeeName?: string } =
      payDriver && input.driverId !== undefined && input.driverId !== null
        ? { payeeType: "driver", payeeId: input.driverId }
        : input.supplierId !== undefined && input.supplierId !== null
          ? { payeeType: "supplier", payeeId: input.supplierId }
          : { payeeName: station === "" ? "Fuel station" : station };
    const expense = await deps.expenses.draftFor(
      userId,
      {
        categoryId: category.id,
        description: `Fuel ${input.litres} L${station === "" ? "" : ` at ${station}`}`,
        branchId: vehicle.branchId,
        expenseDate: filledAt.toISOString().slice(0, 10),
        ...payee,
        driverId: input.driverId ?? null,
        amount: input.amount,
        vehicleIds: [vehicleId],
        notes: input.notes ?? null,
      },
      vehicle.branchId,
      { type: "fuel_log", id },
    );
    await deps.expenses.submitLoaded(expense, userId, { skipReceiptRule: true });
    const base = expense.snapshot().amountMinor;
    const log: FuelLog = {
      id,
      vehicleId,
      driverId: input.driverId ?? null,
      filledAt,
      litres: Math.round(litres * 100) / 100,
      amountMinor: base,
      odometer: input.odometer,
      fullTank: input.fullTank ?? true,
      station: station === "" ? null : station,
      expenseId: expense.id,
      notes:
        input.notes === undefined || input.notes === null || input.notes.trim() === ""
          ? null
          : input.notes.trim(),
      recordedBy: userId,
      createdAt: now,
    };
    await deps.logs.add(log);
    await recordUserAction(deps, userId, {
      action: "vehicle.fuel_recorded",
      entityType: "vehicle",
      entityId: vehicleId,
      after: {
        fuelLogId: id,
        litres: log.litres,
        amountMinor: log.amountMinor,
        odometer: log.odometer,
      },
    });
    const currency = await deps.expenses.baseCurrency();
    const saved = await deps.expenseRepository.findById(expense.id);
    return { log: view(log, currency), expense: expenseView(saved!.snapshot(), currency) };
  }

  async report(actor: Principal, vehicleId: string, limit: number): Promise<FuelReport> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      await deps.vehicles.reach(actor, vehicleId, "vehicles.view");
      const logs = await deps.logs.forVehicle(vehicleId, limit);
      const currency = await deps.expenses.baseCurrency();
      const efficiency = fuelEfficiency(logs);
      const distance = efficiency.reduce((sum, e) => sum + e.distance, 0);
      const litres = efficiency.reduce((sum, e) => sum + e.litres, 0);
      return {
        logs: logs.map((l) => view(l, currency)),
        efficiency,
        averageKmPerLitre: litres === 0 ? null : Math.round((distance / litres) * 100) / 100,
      };
    });
  }
}

function view(log: FuelLog, currency: string): FuelLogView {
  const { amountMinor, ...rest } = log;
  return {
    ...rest,
    amount: Money.ofMinor(amountMinor, currency).toJSON(),
    pricePerLitre: Money.ofMinor(Math.round(amountMinor / log.litres), currency).toJSON(),
  };
}
