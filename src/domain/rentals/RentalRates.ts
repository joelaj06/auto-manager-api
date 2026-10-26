import { DomainError } from "../errors/DomainError.js";
import { parseDecimal, pow10 } from "../money/Decimal.js";

export class RentalRateError extends DomainError {
  readonly code = "RENTAL_RATE_RULE";
  constructor(message: string) {
    super(message);
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[A-Z0-9][A-Z0-9_-]{0,19}$/;
const PROMO = /^[A-Z0-9]{3,20}$/;

/** A group of interchangeable vehicles customers book (docs/07 §3: "SUV", "Economy"). */
export type VehicleClass = Readonly<{
  id: string;
  code: string;
  name: string;
  description: string | null;
  /** Renter rules checked at booking (docs/07 §8); null: no rule. */
  minDriverAge: number | null;
  minLicenceYears: number | null;
  sort: number;
  active: boolean;
}>;

/** A seasonal adjustment of a rate plan, in percent of every rate (+25 at Christmas, −10 in the rains). */
export type RateSeason = Readonly<{
  id: string;
  name: string;
  /** `YYYY-MM-DD`, both inclusive. */
  startsOn: string;
  endsOn: string;
  /** Decimal percent string, −90 to 500. */
  adjustmentPercent: string;
}>;

/**
 * What a rental costs (docs/07 §4). A plan prices one class, or one vehicle; it may be limited
 * to a branch, and a plan for a customer is that customer's negotiated rate. Amounts are minor
 * units of the plan's currency, entered as the business enters prices (tax inclusive or not).
 */
export type RatePlan = Readonly<{
  id: string;
  code: string;
  name: string;
  classId: string | null;
  vehicleId: string | null;
  branchId: string | null;
  customerId: string | null;
  currency: string;
  hourlyMinor: number | null;
  dailyMinor: number;
  /** Saturdays and Sundays (the weekend days of the settings), and holidays when so set. */
  weekendDailyMinor: number | null;
  /** For 7 days; applied prorated per day from the weekly threshold. */
  weeklyMinor: number | null;
  /** For 30 days; applied prorated per day from the monthly threshold. */
  monthlyMinor: number | null;
  /** Shortest rental charged by the hour. */
  minHours: number;
  /** Null: unlimited mileage. */
  includedKmPerDay: number | null;
  extraKmMinor: number | null;
  /** Null: no chauffeur offered with this plan. */
  chauffeurDailyMinor: number | null;
  chauffeurOvernightMinor: number | null;
  chauffeurOutOfTownMinor: number | null;
  /** Null: the business's default sales tax code. */
  taxCode: string | null;
  validFrom: string | null;
  validTo: string | null;
  seasons: readonly RateSeason[];
  active: boolean;
  notes: string | null;
}>;

export const EXTRA_CATEGORIES = ["equipment", "insurance", "driver", "service", "other"] as const;
export type ExtraCategory = (typeof EXTRA_CATEGORIES)[number];
export const EXTRA_CHARGES = ["per_day", "per_rental"] as const;
export type ExtraCharge = (typeof EXTRA_CHARGES)[number];

/** Child seat, GPS, Wi-Fi, an additional driver, CDW … (docs/07 §4). */
export type RentalExtra = Readonly<{
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: ExtraCategory;
  charge: ExtraCharge;
  priceMinor: number;
  /** A per-day extra never costs more than this per unit and rental; null: no cap. */
  maxChargeMinor: number | null;
  maxQuantity: number;
  taxCode: string | null;
  /** Empty: every class. */
  classIds: readonly string[];
  sort: number;
  active: boolean;
}>;

/** Where vehicles are delivered or collected, or driven beyond (out-of-town surcharge). */
export type RentalZone = Readonly<{
  id: string;
  name: string;
  deliveryFeeMinor: number;
  collectionFeeMinor: number;
  /** Per rental day when the vehicle goes to this zone. */
  outOfTownDailyMinor: number;
  active: boolean;
}>;

export type PromoCode = Readonly<{
  id: string;
  code: string;
  description: string | null;
  /** Exactly one of percent or amount (in the business's base currency). */
  discountPercent: string | null;
  discountMinor: number | null;
  validFrom: string | null;
  validTo: string | null;
  minDays: number | null;
  maxUses: number | null;
  usedCount: number;
  classIds: readonly string[];
  active: boolean;
}>;

export type PublicHoliday = Readonly<{ id: string; date: string; name: string }>;

/** Business-wide rental pricing rules (organisation settings). */
export type RentalSettings = Readonly<{
  /** ISO weekdays priced at the weekend rate (6 = Saturday, 7 = Sunday). */
  weekendDays: readonly number[];
  /** Public holidays are priced at the weekend rate. */
  holidaysAsWeekend: boolean;
  /** Late minutes forgiven before the extra time is charged. */
  graceMinutes: number;
  /** From this many rental days the weekly rate applies. */
  weeklyFromDays: number;
  /** From this many rental days the monthly rate applies. */
  monthlyFromDays: number;
  /** Discount an agent may give with rentals.discount.apply when the role sets no max_percent. */
  maxDiscountPercent: string;
}>;

export const DEFAULT_RENTAL_SETTINGS: RentalSettings = Object.freeze({
  weekendDays: Object.freeze([6, 7]),
  holidaysAsWeekend: true,
  graceMinutes: 59,
  weeklyFromDays: 7,
  monthlyFromDays: 28,
  maxDiscountPercent: "10",
});

const amount = (value: number | null, what: string, positive = false) => {
  if (value === null) return;
  if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0))
    throw new RentalRateError(`${what} must be ${positive ? "more than zero" : "zero or more"}`);
};

/** A percent within bounds, as a decimal string. */
export function assertPercent(value: string, min: number, max: number, what: string): void {
  const p = parseDecimal(value);
  if (p.scale > 2) throw new RentalRateError(`${what} has at most two decimals`);
  const scaled = pow10(p.scale);
  if (p.units < BigInt(min) * scaled || p.units > BigInt(max) * scaled)
    throw new RentalRateError(`${what} is between ${min} and ${max} percent`);
}

const dates = (from: string | null, to: string | null, what: string) => {
  if ((from !== null && !DATE.test(from)) || (to !== null && !DATE.test(to)))
    throw new RentalRateError(`${what}: dates are YYYY-MM-DD`);
  if (from !== null && to !== null && to < from)
    throw new RentalRateError(`${what}: the end is before the start`);
};

export function assertCode(code: string, what: string): void {
  if (!CODE.test(code))
    throw new RentalRateError(`${what} codes use capitals, digits, - and _ (e.g. SUV, ECO-01)`);
}

const name = (value: string, max: number, what: string) => {
  if (value.trim().length === 0 || value.length > max)
    throw new RentalRateError(`${what} needs a name (up to ${max} characters)`);
};

export function validateVehicleClass(c: VehicleClass): VehicleClass {
  assertCode(c.code, "Class");
  name(c.name, 80, "A class");
  if (c.minDriverAge !== null && (c.minDriverAge < 16 || c.minDriverAge > 99))
    throw new RentalRateError("The minimum driver age is between 16 and 99");
  if (c.minLicenceYears !== null && (c.minLicenceYears < 0 || c.minLicenceYears > 60))
    throw new RentalRateError("The minimum licence years are between 0 and 60");
  return c;
}

export function validateRatePlan(p: RatePlan): RatePlan {
  assertCode(p.code, "Rate plan");
  name(p.name, 120, "A rate plan");
  if ((p.classId === null) === (p.vehicleId === null))
    throw new RentalRateError("A rate plan prices either a class or one vehicle");
  amount(p.dailyMinor, "The daily rate", true);
  amount(p.hourlyMinor, "The hourly rate", true);
  amount(p.weekendDailyMinor, "The weekend rate", true);
  amount(p.weeklyMinor, "The weekly rate", true);
  amount(p.monthlyMinor, "The monthly rate", true);
  if (!Number.isInteger(p.minHours) || p.minHours < 1 || p.minHours > 23)
    throw new RentalRateError("The minimum hours are between 1 and 23");
  if ((p.includedKmPerDay === null) !== (p.extraKmMinor === null))
    throw new RentalRateError("Limited mileage needs both the km per day and the extra km price");
  if (p.includedKmPerDay !== null && (p.includedKmPerDay < 1 || p.includedKmPerDay > 10_000))
    throw new RentalRateError("The included km per day are between 1 and 10,000");
  amount(p.extraKmMinor, "The extra km price");
  amount(p.chauffeurDailyMinor, "The chauffeur fee", true);
  amount(p.chauffeurOvernightMinor, "The overnight allowance");
  amount(p.chauffeurOutOfTownMinor, "The out-of-town allowance");
  if (
    p.chauffeurDailyMinor === null &&
    (p.chauffeurOvernightMinor !== null || p.chauffeurOutOfTownMinor !== null)
  )
    throw new RentalRateError("Chauffeur allowances need a chauffeur fee");
  dates(p.validFrom, p.validTo, "Validity");
  const seasons = [...p.seasons].sort((a, b) => a.startsOn.localeCompare(b.startsOn));
  for (const [i, s] of seasons.entries()) {
    name(s.name, 80, "A season");
    if (!DATE.test(s.startsOn) || !DATE.test(s.endsOn))
      throw new RentalRateError(`${s.name}: dates are YYYY-MM-DD`);
    dates(s.startsOn, s.endsOn, s.name);
    assertPercent(s.adjustmentPercent, -90, 500, `${s.name}'s adjustment`);
    const previous = seasons[i - 1];
    if (previous !== undefined && previous.endsOn >= s.startsOn)
      throw new RentalRateError(`Seasons ${previous.name} and ${s.name} overlap`);
  }
  return { ...p, seasons };
}

export function validateExtra(e: RentalExtra): RentalExtra {
  assertCode(e.code, "Extra");
  name(e.name, 80, "An extra");
  amount(e.priceMinor, "The price");
  amount(e.maxChargeMinor, "The cap");
  if (e.maxChargeMinor !== null && e.charge !== "per_day")
    throw new RentalRateError("Only per-day extras have a cap");
  if (!Number.isInteger(e.maxQuantity) || e.maxQuantity < 1 || e.maxQuantity > 20)
    throw new RentalRateError("The maximum quantity is between 1 and 20");
  return e;
}

export function validateZone(z: RentalZone): RentalZone {
  name(z.name, 80, "A zone");
  amount(z.deliveryFeeMinor, "The delivery fee");
  amount(z.collectionFeeMinor, "The collection fee");
  amount(z.outOfTownDailyMinor, "The out-of-town surcharge");
  return z;
}

export function validatePromo(p: PromoCode): PromoCode {
  if (!PROMO.test(p.code))
    throw new RentalRateError("Promo codes are 3 to 20 capitals and digits (e.g. EASTER25)");
  if ((p.discountPercent === null) === (p.discountMinor === null))
    throw new RentalRateError("A promo code takes off either a percent or an amount");
  if (p.discountPercent !== null) assertPercent(p.discountPercent, 1, 100, "The discount");
  amount(p.discountMinor, "The discount", true);
  dates(p.validFrom, p.validTo, "Validity");
  if (p.minDays !== null && (p.minDays < 1 || p.minDays > 365))
    throw new RentalRateError("The minimum days are between 1 and 365");
  if (p.maxUses !== null && p.maxUses < 1)
    throw new RentalRateError("The maximum uses are at least 1");
  return p;
}

export function validateSettings(s: RentalSettings): RentalSettings {
  if (s.weekendDays.some((d) => !Number.isInteger(d) || d < 1 || d > 7))
    throw new RentalRateError("Weekend days are ISO weekdays, 1 (Monday) to 7 (Sunday)");
  if (!Number.isInteger(s.graceMinutes) || s.graceMinutes < 0 || s.graceMinutes > 240)
    throw new RentalRateError("The grace is between 0 and 240 minutes");
  if (s.weeklyFromDays < 2 || s.weeklyFromDays > 7)
    throw new RentalRateError("The weekly rate starts from 2 to 7 days");
  if (s.monthlyFromDays < 8 || s.monthlyFromDays > 30)
    throw new RentalRateError("The monthly rate starts from 8 to 30 days");
  assertPercent(s.maxDiscountPercent, 0, 100, "The maximum discount");
  return { ...s, weekendDays: [...new Set(s.weekendDays)].sort((a, b) => a - b) };
}
