import type {
  PromoCode,
  PublicHoliday,
  RatePlan,
  RentalExtra,
  RentalSettings,
  RentalZone,
  VehicleClass,
} from "../../domain/rentals/RentalRates.js";

export type RatePlanFilter = Readonly<{
  classId?: string;
  vehicleId?: string;
  customerId?: string;
  includeInactive?: boolean;
}>;

/** Rental rate data of the current tenant (tenant unit of work), docs/07 §4. */
export interface IRentalRates {
  classes(): Promise<VehicleClass[]>;
  vehicleClass(id: string): Promise<VehicleClass | null>;
  saveClass(c: VehicleClass, actorId: string | null): Promise<void>;
  /** Vehicles (not removed) in each class. */
  classVehicleCounts(): Promise<ReadonlyMap<string, number>>;
  vehicleClassId(vehicleId: string): Promise<string | null>;
  assignVehicleClass(vehicleId: string, classId: string | null): Promise<void>;

  plans(filter?: RatePlanFilter): Promise<RatePlan[]>;
  plan(id: string): Promise<RatePlan | null>;
  /** Saves the plan and replaces its seasons. */
  savePlan(p: RatePlan, actorId: string | null): Promise<void>;

  extras(): Promise<RentalExtra[]>;
  extra(id: string): Promise<RentalExtra | null>;
  saveExtra(e: RentalExtra, actorId: string | null): Promise<void>;

  zones(): Promise<RentalZone[]>;
  zone(id: string): Promise<RentalZone | null>;
  saveZone(z: RentalZone, actorId: string | null): Promise<void>;

  promos(): Promise<PromoCode[]>;
  promo(id: string): Promise<PromoCode | null>;
  promoByCode(code: string): Promise<PromoCode | null>;
  savePromo(p: PromoCode, actorId: string | null): Promise<void>;

  /** Is `value` already used as a code (classes, plans, extras, promos) or name (zones)? */
  taken(
    kind: "class" | "plan" | "extra" | "zone" | "promo",
    value: string,
    exceptId: string | null,
  ): Promise<boolean>;

  holidays(from: string, to: string): Promise<PublicHoliday[]>;
  holiday(id: string): Promise<PublicHoliday | null>;
  holidayOn(date: string): Promise<PublicHoliday | null>;
  saveHoliday(h: PublicHoliday, actorId: string | null): Promise<void>;
  deleteHoliday(id: string): Promise<void>;

  settings(): Promise<RentalSettings>;
  saveSettings(s: RentalSettings): Promise<void>;
}
