import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import { Money } from "../../../domain/money/Money.js";
import {
  RentalRateError,
  validateExtra,
  validatePromo,
  validateRatePlan,
  validateSettings,
  validateVehicleClass,
  validateZone,
  type ExtraCategory,
  type ExtraCharge,
  type PromoCode,
  type PublicHoliday,
  type RatePlan,
  type RentalExtra,
  type RentalSettings,
  type RentalZone,
  type VehicleClass,
} from "../../../domain/rentals/RentalRates.js";
import type { Principal } from "../../authorization/Principal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IBranches } from "../../ports/IBranches.js";
import type { IPartyDirectory } from "../../ports/IFinanceRecords.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IRentalRates, RatePlanFilter } from "../../ports/IRentalRates.js";
import type { ITenantReferenceData } from "../../ports/IReferenceData.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { VehicleAccess } from "../vehicles/VehicleAccess.js";

export class RentalRateNotFoundError extends ApplicationError {
  readonly code = "RENTAL_RATE_NOT_FOUND";
  constructor(what: string) {
    super(`${what} not found`);
  }
}

/** Amounts as clients send them ("300.00"); null clears an optional one. */
type Amount = string | null;

export type VehicleClassInput = Readonly<{
  code: string;
  name: string;
  description?: string | null;
  minDriverAge?: number | null;
  minLicenceYears?: number | null;
  turnaroundMinutes?: number;
  sort?: number;
  active?: boolean;
}>;

export type SeasonInput = Readonly<{
  name: string;
  startsOn: string;
  endsOn: string;
  adjustmentPercent: string;
}>;

export type RatePlanInput = Readonly<{
  code: string;
  name: string;
  classId?: string | null;
  vehicleId?: string | null;
  branchId?: string | null;
  customerId?: string | null;
  hourlyRate?: Amount;
  dailyRate: string;
  weekendRate?: Amount;
  weeklyRate?: Amount;
  monthlyRate?: Amount;
  minHours?: number;
  includedKmPerDay?: number | null;
  extraKmRate?: Amount;
  chauffeurDaily?: Amount;
  chauffeurOvernight?: Amount;
  chauffeurOutOfTown?: Amount;
  taxCode?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  seasons?: readonly SeasonInput[];
  active?: boolean;
  notes?: string | null;
}>;

export type ExtraInput = Readonly<{
  code: string;
  name: string;
  description?: string | null;
  category: ExtraCategory;
  charge: ExtraCharge;
  price: string;
  maxCharge?: Amount;
  maxQuantity?: number;
  taxCode?: string | null;
  classIds?: readonly string[];
  sort?: number;
  active?: boolean;
}>;

export type ZoneInput = Readonly<{
  name: string;
  deliveryFee?: string;
  collectionFee?: string;
  outOfTownDaily?: string;
  active?: boolean;
}>;

export type PromoInput = Readonly<{
  code: string;
  description?: string | null;
  discountPercent?: string | null;
  discount?: Amount;
  validFrom?: string | null;
  validTo?: string | null;
  minDays?: number | null;
  maxUses?: number | null;
  classIds?: readonly string[];
  active?: boolean;
}>;

export type VehicleClassView = VehicleClass & Readonly<{ vehicles: number }>;

/**
 * The rental rate catalogue (docs/07 §4): vehicle classes and the vehicles in them, rate plans
 * with their seasons, extras, zones, promo codes, public holidays and the pricing settings.
 * Nothing is deleted except a holiday entered by mistake: rows are deactivated, since quotes and
 * bookings refer to them. Every change is audited.
 */
export class RentalRateAdministration {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      rates: IRentalRates;
      vehicles: IVehicleRepository;
      vehicleAccess: VehicleAccess;
      branches: IBranches;
      parties: IPartyDirectory;
      reference: ITenantReferenceData;
      organisation: IOrganisationSettings;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
    }>,
  ) {}

  // --- classes ---

  async classes(includeInactive = false): Promise<VehicleClassView[]> {
    const { rates } = this.deps;
    return this.deps.unitOfWork.run(async () => {
      const counts = await rates.classVehicleCounts();
      return (await rates.classes())
        .filter((c) => includeInactive || c.active)
        .map((c) => ({ ...c, vehicles: counts.get(c.id) ?? 0 }));
    });
  }

  createClass(actor: Principal, input: VehicleClassInput): Promise<VehicleClass> {
    return this.saveClass(actor, null, input);
  }

  updateClass(
    actor: Principal,
    id: string,
    input: Partial<VehicleClassInput>,
  ): Promise<VehicleClass> {
    return this.saveClass(actor, id, input);
  }

  private saveClass(
    actor: Principal,
    id: string | null,
    input: Partial<VehicleClassInput>,
  ): Promise<VehicleClass> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = id === null ? null : await this.found(deps.rates.vehicleClass(id), "Class");
      const after = validateVehicleClass({
        id: before?.id ?? deps.ids.next(),
        code: (input.code ?? before?.code ?? "").trim().toUpperCase(),
        name: (input.name ?? before?.name ?? "").trim(),
        description: pick(input.description, before?.description ?? null),
        minDriverAge: pick(input.minDriverAge, before?.minDriverAge ?? null),
        minLicenceYears: pick(input.minLicenceYears, before?.minLicenceYears ?? null),
        turnaroundMinutes: input.turnaroundMinutes ?? before?.turnaroundMinutes ?? 0,
        sort: input.sort ?? before?.sort ?? 1_000,
        active: input.active ?? before?.active ?? true,
      });
      if (await deps.rates.taken("class", after.code, before?.id ?? null))
        throw new RentalRateError(`The class code ${after.code} is already used`);
      await deps.rates.saveClass(after, actor.userId);
      await this.audit(actor, "vehicle_class", after.id, before, after);
      return after;
    });
  }

  /** Puts a vehicle in a class (or takes it out with null). */
  assignVehicleClass(
    actor: Principal,
    vehicleId: string,
    classId: string | null,
  ): Promise<Readonly<{ vehicleId: string; classId: string | null }>> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      await deps.vehicleAccess.reach(actor, vehicleId, "vehicles.update", true);
      if (classId !== null) {
        const target = await this.found(deps.rates.vehicleClass(classId), "Class");
        if (!target.active) throw new RentalRateError(`${target.name} is not active`);
      }
      const before = await deps.rates.vehicleClassId(vehicleId);
      await deps.rates.assignVehicleClass(vehicleId, classId);
      await recordUserAction(deps, actor.userId, {
        action: "vehicle.rental_class_changed",
        entityType: "vehicle",
        entityId: vehicleId,
        before: { classId: before },
        after: { classId },
      });
      return { vehicleId, classId };
    });
  }

  // --- rate plans ---

  plans(filter: RatePlanFilter = {}): Promise<RatePlan[]> {
    return this.deps.unitOfWork.run(() => this.deps.rates.plans(filter));
  }

  plan(id: string): Promise<RatePlan> {
    return this.deps.unitOfWork.run(() => this.found(this.deps.rates.plan(id), "Rate plan"));
  }

  createPlan(actor: Principal, input: RatePlanInput): Promise<RatePlan> {
    return this.savePlan(actor, null, input);
  }

  updatePlan(actor: Principal, id: string, input: Partial<RatePlanInput>): Promise<RatePlan> {
    return this.savePlan(actor, id, input);
  }

  private savePlan(
    actor: Principal,
    id: string | null,
    input: Partial<RatePlanInput>,
  ): Promise<RatePlan> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = id === null ? null : await this.found(deps.rates.plan(id), "Rate plan");
      const currency = before?.currency ?? (await deps.organisation.get()).baseCurrency;
      const m = (value: Amount | undefined, previous: number | null) =>
        value === undefined ? previous : value === null ? null : minor(value, currency);
      const after = validateRatePlan({
        id: before?.id ?? deps.ids.next(),
        code: (input.code ?? before?.code ?? "").trim().toUpperCase(),
        name: (input.name ?? before?.name ?? "").trim(),
        classId: pick(input.classId, before?.classId ?? null),
        vehicleId: pick(input.vehicleId, before?.vehicleId ?? null),
        branchId: pick(input.branchId, before?.branchId ?? null),
        customerId: pick(input.customerId, before?.customerId ?? null),
        currency,
        hourlyMinor: m(input.hourlyRate, before?.hourlyMinor ?? null),
        dailyMinor: m(input.dailyRate, before?.dailyMinor ?? null) ?? 0,
        weekendDailyMinor: m(input.weekendRate, before?.weekendDailyMinor ?? null),
        weeklyMinor: m(input.weeklyRate, before?.weeklyMinor ?? null),
        monthlyMinor: m(input.monthlyRate, before?.monthlyMinor ?? null),
        minHours: input.minHours ?? before?.minHours ?? 1,
        includedKmPerDay: pick(input.includedKmPerDay, before?.includedKmPerDay ?? null),
        extraKmMinor: m(input.extraKmRate, before?.extraKmMinor ?? null),
        chauffeurDailyMinor: m(input.chauffeurDaily, before?.chauffeurDailyMinor ?? null),
        chauffeurOvernightMinor: m(
          input.chauffeurOvernight,
          before?.chauffeurOvernightMinor ?? null,
        ),
        chauffeurOutOfTownMinor: m(
          input.chauffeurOutOfTown,
          before?.chauffeurOutOfTownMinor ?? null,
        ),
        taxCode: pick(input.taxCode, before?.taxCode ?? null),
        validFrom: pick(input.validFrom, before?.validFrom ?? null),
        validTo: pick(input.validTo, before?.validTo ?? null),
        seasons:
          input.seasons === undefined
            ? (before?.seasons ?? [])
            : input.seasons.map((s) => ({
                id: deps.ids.next(),
                name: s.name.trim(),
                startsOn: s.startsOn,
                endsOn: s.endsOn,
                adjustmentPercent: s.adjustmentPercent.trim(),
              })),
        active: input.active ?? before?.active ?? true,
        notes: pick(input.notes, before?.notes ?? null),
      });
      if (await deps.rates.taken("plan", after.code, before?.id ?? null))
        throw new RentalRateError(`The rate plan code ${after.code} is already used`);
      if (after.classId !== null) await this.found(deps.rates.vehicleClass(after.classId), "Class");
      if (after.vehicleId !== null && (await deps.vehicles.findById(after.vehicleId)) === null)
        throw new RentalRateNotFoundError("Vehicle");
      if (
        after.branchId !== null &&
        !(await deps.branches.list()).some((b) => b.id === after.branchId)
      )
        throw new RentalRateNotFoundError("Branch");
      if (
        after.customerId !== null &&
        (await deps.parties.find("customer", after.customerId)) === null
      )
        throw new RentalRateNotFoundError("Customer");
      await this.assertTaxCode(after.taxCode);
      await deps.rates.savePlan(after, actor.userId);
      await this.audit(actor, "rental_rate_plan", after.id, before, after);
      return after;
    });
  }

  // --- extras ---

  extras(includeInactive = false): Promise<RentalExtra[]> {
    return this.deps.unitOfWork.run(async () =>
      (await this.deps.rates.extras()).filter((e) => includeInactive || e.active),
    );
  }

  createExtra(actor: Principal, input: ExtraInput): Promise<RentalExtra> {
    return this.saveExtra(actor, null, input);
  }

  updateExtra(actor: Principal, id: string, input: Partial<ExtraInput>): Promise<RentalExtra> {
    return this.saveExtra(actor, id, input);
  }

  private saveExtra(
    actor: Principal,
    id: string | null,
    input: Partial<ExtraInput>,
  ): Promise<RentalExtra> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = id === null ? null : await this.found(deps.rates.extra(id), "Extra");
      const currency = (await deps.organisation.get()).baseCurrency;
      const after = validateExtra({
        id: before?.id ?? deps.ids.next(),
        code: (input.code ?? before?.code ?? "").trim().toUpperCase(),
        name: (input.name ?? before?.name ?? "").trim(),
        description: pick(input.description, before?.description ?? null),
        category: input.category ?? before?.category ?? "other",
        charge: input.charge ?? before?.charge ?? "per_rental",
        priceMinor:
          input.price === undefined ? (before?.priceMinor ?? 0) : minor(input.price, currency),
        maxChargeMinor:
          input.maxCharge === undefined
            ? (before?.maxChargeMinor ?? null)
            : input.maxCharge === null
              ? null
              : minor(input.maxCharge, currency),
        maxQuantity: input.maxQuantity ?? before?.maxQuantity ?? 1,
        taxCode: pick(input.taxCode, before?.taxCode ?? null),
        classIds: [...new Set(input.classIds ?? before?.classIds ?? [])],
        sort: input.sort ?? before?.sort ?? 1_000,
        active: input.active ?? before?.active ?? true,
      });
      if (await deps.rates.taken("extra", after.code, before?.id ?? null))
        throw new RentalRateError(`The extra code ${after.code} is already used`);
      await this.assertClasses(after.classIds);
      await this.assertTaxCode(after.taxCode);
      await deps.rates.saveExtra(after, actor.userId);
      await this.audit(actor, "rental_extra", after.id, before, after);
      return after;
    });
  }

  // --- zones ---

  zones(includeInactive = false): Promise<RentalZone[]> {
    return this.deps.unitOfWork.run(async () =>
      (await this.deps.rates.zones()).filter((z) => includeInactive || z.active),
    );
  }

  createZone(actor: Principal, input: ZoneInput): Promise<RentalZone> {
    return this.saveZone(actor, null, input);
  }

  updateZone(actor: Principal, id: string, input: Partial<ZoneInput>): Promise<RentalZone> {
    return this.saveZone(actor, id, input);
  }

  private saveZone(
    actor: Principal,
    id: string | null,
    input: Partial<ZoneInput>,
  ): Promise<RentalZone> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = id === null ? null : await this.found(deps.rates.zone(id), "Zone");
      const currency = (await deps.organisation.get()).baseCurrency;
      const m = (value: string | undefined, previous: number | undefined) =>
        value === undefined ? (previous ?? 0) : minor(value, currency);
      const after = validateZone({
        id: before?.id ?? deps.ids.next(),
        name: (input.name ?? before?.name ?? "").trim(),
        deliveryFeeMinor: m(input.deliveryFee, before?.deliveryFeeMinor),
        collectionFeeMinor: m(input.collectionFee, before?.collectionFeeMinor),
        outOfTownDailyMinor: m(input.outOfTownDaily, before?.outOfTownDailyMinor),
        active: input.active ?? before?.active ?? true,
      });
      if (await deps.rates.taken("zone", after.name, before?.id ?? null))
        throw new RentalRateError(`There is already a zone called ${after.name}`);
      await deps.rates.saveZone(after, actor.userId);
      await this.audit(actor, "rental_zone", after.id, before, after);
      return after;
    });
  }

  // --- promo codes ---

  promos(): Promise<PromoCode[]> {
    return this.deps.unitOfWork.run(() => this.deps.rates.promos());
  }

  createPromo(actor: Principal, input: PromoInput): Promise<PromoCode> {
    return this.savePromo(actor, null, input);
  }

  updatePromo(actor: Principal, id: string, input: Partial<PromoInput>): Promise<PromoCode> {
    return this.savePromo(actor, id, input);
  }

  private savePromo(
    actor: Principal,
    id: string | null,
    input: Partial<PromoInput>,
  ): Promise<PromoCode> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = id === null ? null : await this.found(deps.rates.promo(id), "Promo code");
      const currency = (await deps.organisation.get()).baseCurrency;
      // Setting one kind of discount clears the other.
      const percentGiven = input.discountPercent !== undefined && input.discountPercent !== null;
      const amountGiven = input.discount !== undefined && input.discount !== null;
      const after = validatePromo({
        id: before?.id ?? deps.ids.next(),
        code: (input.code ?? before?.code ?? "").trim().toUpperCase(),
        description: pick(input.description, before?.description ?? null),
        discountPercent: percentGiven
          ? input.discountPercent.trim()
          : amountGiven
            ? null
            : pick(input.discountPercent, before?.discountPercent ?? null),
        discountMinor: amountGiven
          ? minor(input.discount, currency)
          : percentGiven
            ? null
            : input.discount === null
              ? null
              : (before?.discountMinor ?? null),
        validFrom: pick(input.validFrom, before?.validFrom ?? null),
        validTo: pick(input.validTo, before?.validTo ?? null),
        minDays: pick(input.minDays, before?.minDays ?? null),
        maxUses: pick(input.maxUses, before?.maxUses ?? null),
        usedCount: before?.usedCount ?? 0,
        classIds: [...new Set(input.classIds ?? before?.classIds ?? [])],
        active: input.active ?? before?.active ?? true,
      });
      if (await deps.rates.taken("promo", after.code, before?.id ?? null))
        throw new RentalRateError(`The promo code ${after.code} is already used`);
      await this.assertClasses(after.classIds);
      await deps.rates.savePromo(after, actor.userId);
      await this.audit(actor, "rental_promo_code", after.id, before, after);
      return after;
    });
  }

  // --- holidays ---

  holidays(year: number): Promise<PublicHoliday[]> {
    return this.deps.unitOfWork.run(() =>
      this.deps.rates.holidays(`${year}-01-01`, `${year}-12-31`),
    );
  }

  addHoliday(
    actor: Principal,
    input: Readonly<{ date: string; name: string }>,
  ): Promise<PublicHoliday> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (input.name.trim().length === 0 || input.name.length > 80)
        throw new RentalRateError("A holiday needs a name (up to 80 characters)");
      const existing = await deps.rates.holidayOn(input.date);
      if (existing !== null)
        throw new RentalRateError(`${input.date} is already a holiday (${existing.name})`);
      const holiday: PublicHoliday = {
        id: deps.ids.next(),
        date: input.date,
        name: input.name.trim(),
      };
      await deps.rates.saveHoliday(holiday, actor.userId);
      await this.audit(actor, "public_holiday", holiday.id, null, holiday);
      return holiday;
    });
  }

  removeHoliday(actor: Principal, id: string): Promise<void> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await this.found(deps.rates.holiday(id), "Holiday");
      await deps.rates.deleteHoliday(id);
      await this.audit(actor, "public_holiday", id, before, null);
    });
  }

  // --- settings ---

  settings(): Promise<RentalSettings> {
    return this.deps.unitOfWork.run(() => this.deps.rates.settings());
  }

  updateSettings(actor: Principal, changes: Partial<RentalSettings>): Promise<RentalSettings> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await deps.rates.settings();
      const after = validateSettings({ ...before, ...changes });
      if (after.monthlyFromDays <= after.weeklyFromDays)
        throw new RentalRateError("The monthly rate starts after the weekly rate");
      await deps.rates.saveSettings(after);
      await recordUserAction(deps, actor.userId, {
        action: "settings.rentals_updated",
        entityType: "organisation",
        entityId: null,
        before,
        after,
      });
      return after;
    });
  }

  // --- helpers ---

  private async found<T>(lookup: Promise<T | null>, what: string): Promise<T> {
    const value = await lookup;
    if (value === null) throw new RentalRateNotFoundError(what);
    return value;
  }

  private async assertClasses(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const known = new Set((await this.deps.rates.classes()).map((c) => c.id));
    if (ids.some((id) => !known.has(id))) throw new RentalRateNotFoundError("Class");
  }

  private async assertTaxCode(code: string | null): Promise<void> {
    if (code === null) return;
    const tax = await this.deps.reference.taxCode(code);
    if (tax === null || !tax.active || !tax.appliesTo.includes("sales"))
      throw new RentalRateError(`${code} is not an active sales tax code`);
  }

  private audit(
    actor: Principal,
    entityType: string,
    entityId: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    return recordUserAction(this.deps, actor.userId, {
      action: `${entityType}.${before === null ? "created" : after === null ? "deleted" : "updated"}`,
      entityType,
      entityId,
      before,
      after,
    });
  }
}

/** `value` when given (null included), otherwise `previous`. */
function pick<T>(value: T | undefined, previous: T): T {
  return value === undefined ? previous : value;
}

function minor(amount: string, currency: string): number {
  return Money.parse(amount, currency).amountMinor;
}
