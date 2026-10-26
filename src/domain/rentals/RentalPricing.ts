import { DomainError } from "../errors/DomainError.js";
import { divideHalfEven } from "../money/Decimal.js";
import { Money } from "../money/Money.js";
import type { TaxCode, TaxLine } from "../tax/TaxCode.js";
import {
  assertPercent,
  type PromoCode,
  type RatePlan,
  type RateSeason,
  type RentalExtra,
  type RentalSettings,
  type RentalZone,
} from "./RentalRates.js";

export class RentalPricingError extends DomainError {
  readonly code = "RENTAL_PRICING";
  constructor(message: string) {
    super(message);
  }
}

const MINUTE_MS = 60_000;
const DAY_MINUTES = 1_440;
const MAX_DAYS = 366;
/** Days a weekly and a monthly rate are for (prorated per day). */
const PERIOD = { weekly: 7, monthly: 30 } as const;

export type RentalTier = "hourly" | "daily" | "weekly" | "monthly";

export type QuoteLineKind =
  | "rental"
  | "chauffeur"
  | "chauffeur_overnight"
  | "chauffeur_out_of_town"
  | "extra"
  | "delivery"
  | "collection"
  | "out_of_town"
  | "extra_km_estimate";

export type QuoteLine = Readonly<{
  kind: QuoteLineKind;
  /** The extra or zone priced, when there is one. */
  refId: string | null;
  description: string;
  quantity: number;
  unit: "hour" | "day" | "night" | "rental" | "km";
  rate: Money;
  amount: Money;
  discount: Money;
  /** Amount less discount, before tax (tax worked back when prices include it). */
  net: Money;
  taxCode: string | null;
  taxComponents: TaxLine["components"];
  tax: Money;
  total: Money;
}>;

export type QuoteInput = Readonly<{
  pickupAt: Date;
  returnAt: Date;
  /** The business's local date (YYYY-MM-DD) of an instant. */
  localDate: (instant: Date) => string;
  plan: RatePlan;
  /** The class booked (extras and promo codes may be limited to classes). */
  classId: string | null;
  settings: RentalSettings;
  holidays: ReadonlySet<string>;
  extras: readonly Readonly<{ extra: RentalExtra; quantity: number }>[];
  chauffeur: Readonly<{ overnights: number; outOfTownDays: number }> | null;
  delivery: RentalZone | null;
  collection: RentalZone | null;
  /** Driven to this zone: its out-of-town surcharge per day. */
  destination: RentalZone | null;
  estimatedKm: number | null;
  promo: PromoCode | null;
  /** A discount given by the agent, percent of the rental charge (limits checked by the caller). */
  discountPercent: string | null;
  /** An agreed rental charge replacing the computed one (rentals.price.override). */
  override: Readonly<{ amountMinor: number; reason: string }> | null;
  tax: Readonly<{
    registered: boolean;
    pricesIncludeTax: boolean;
    defaultCode: string | null;
    codes: ReadonlyMap<string, TaxCode>;
  }>;
}>;

/**
 * Everything a quote was priced with, resolved (decision 333): a booking keeps it, so its
 * extensions, late return and mileage are priced at the rates, extras, zones and promo code it
 * was booked with, whatever changes in the catalogue later. Plain JSON.
 */
export type PricingTerms = Readonly<{
  plan: RatePlan;
  classId: string | null;
  extras: readonly Readonly<{ extra: RentalExtra; quantity: number }>[];
  chauffeur: Readonly<{ overnights: number; outOfTownDays: number }> | null;
  delivery: RentalZone | null;
  collection: RentalZone | null;
  destination: RentalZone | null;
  estimatedKm: number | null;
  promo: PromoCode | null;
  discountPercent: string | null;
  override: Readonly<{ amountMinor: number; reason: string }> | null;
}>;

export type RentalQuote = Readonly<{
  currency: string;
  pickupAt: Date;
  returnAt: Date;
  durationMinutes: number;
  tier: RentalTier;
  /** The rental charge was capped at one period of a higher tier. */
  cappedBy: "weekly" | "monthly" | null;
  /** Days the rental is charged (and extras, chauffeur and mileage counted) for. */
  days: number;
  /** Hours charged by the hour (a short rental, or the time past the last full day). */
  hours: number;
  plan: Readonly<{ id: string; code: string; name: string }>;
  lines: readonly QuoteLine[];
  mileage:
    | Readonly<{ unlimited: true }>
    | Readonly<{ unlimited: false; includedKm: number; extraKm: Money }>;
  discounts: Readonly<{
    promo: Readonly<{ code: string; amount: Money }> | null;
    manual: Readonly<{ percent: string; amount: Money }> | null;
    override: Readonly<{ reason: string; computed: Money }> | null;
  }>;
  totals: Readonly<{
    subtotal: Money;
    discount: Money;
    net: Money;
    tax: Money;
    total: Money;
    taxComponents: readonly Readonly<{ key: string; name: string; amount: Money }>[];
  }>;
}>;

type Day = Readonly<{
  date: string;
  kind: "weekday" | "weekend" | "holiday";
  season: RateSeason | null;
}>;

type RawLine = Omit<
  QuoteLine,
  "discount" | "net" | "taxCode" | "taxComponents" | "tax" | "total"
> & { taxCode: string | null };

type Charge = Readonly<{ lines: RawLine[]; amount: Money; days: number; hours: number }>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/**
 * The rate plan that prices a rental: active and valid on the pickup date, for the vehicle or its
 * class, the branch (or any) and the customer (or any). A customer's negotiated plan wins, then
 * a vehicle's own plan, then a branch's, then the most recent.
 */
export function selectRatePlan(
  plans: readonly RatePlan[],
  q: Readonly<{
    classId: string | null;
    vehicleId: string | null;
    branchId: string;
    customerId: string | null;
    date: string;
  }>,
): RatePlan | null {
  const fits = plans.filter(
    (p) =>
      p.active &&
      (p.validFrom === null || p.validFrom <= q.date) &&
      (p.validTo === null || q.date <= p.validTo) &&
      ((p.vehicleId !== null && p.vehicleId === q.vehicleId) ||
        (p.classId !== null && p.classId === q.classId)) &&
      (p.branchId === null || p.branchId === q.branchId) &&
      (p.customerId === null || p.customerId === q.customerId),
  );
  const rank = (p: RatePlan) => [
    p.customerId === null ? 0 : 1,
    p.vehicleId === null ? 0 : 1,
    p.branchId === null ? 0 : 1,
  ];
  fits.sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return rb[i]! - ra[i]!;
    return (b.validFrom ?? "").localeCompare(a.validFrom ?? "") || a.code.localeCompare(b.code);
  });
  return fits[0] ?? null;
}

/**
 * Prices a rental (docs/07 §4). Pure: everything it needs is in the input, and the result is
 * the snapshot a booking keeps.
 *
 * Time: whole 24-hour days from the pickup time; the rest is forgiven within the grace, charged
 * by the hour when the plan has an hourly rate and that is cheaper than a day, or as one more
 * day. A rental shorter than a day is charged by the hour (at least the plan's minimum hours)
 * when cheaper than a day. Each day is priced on the business's local date it starts on:
 * weekend days and holidays at the weekend rate, seasons adjusting every rate.
 *
 * Tiers: from the weekly threshold the weekly rate applies prorated per day, from the monthly
 * threshold the monthly rate; and a rental never costs more than one full period of a higher
 * tier it fits in (six days at the daily rate are capped at the weekly rate).
 *
 * Discounts (promo code, then the agent's percent) apply to the rental charge only, spread over
 * its lines; an agreed price replaces the rental charge and takes no other discount. Tax is
 * charged per line with the codes in force on the pickup date.
 */
export function quoteRental(input: QuoteInput): RentalQuote {
  const { plan, settings } = input;
  const currency = plan.currency;
  const money = (minor: number) => Money.ofMinor(minor, currency);
  const pickupDate = input.localDate(input.pickupAt);

  if (!plan.active) throw new RentalPricingError(`Rate plan ${plan.code} is not active`);
  if (
    (plan.validFrom !== null && pickupDate < plan.validFrom) ||
    (plan.validTo !== null && pickupDate > plan.validTo)
  )
    throw new RentalPricingError(`Rate plan ${plan.code} is not valid on ${pickupDate}`);
  const durationMinutes = Math.ceil(
    (input.returnAt.getTime() - input.pickupAt.getTime()) / MINUTE_MS,
  );
  if (durationMinutes <= 0) throw new RentalPricingError("The return is after the pickup");
  if (durationMinutes > MAX_DAYS * DAY_MINUTES)
    throw new RentalPricingError(`A rental is at most ${MAX_DAYS} days`);

  // --- days and their prices ---
  const dayAt = (k: number): Day => {
    const date = input.localDate(new Date(input.pickupAt.getTime() + k * DAY_MINUTES * MINUTE_MS));
    const season = plan.seasons.find((s) => s.startsOn <= date && date <= s.endsOn) ?? null;
    if (settings.holidaysAsWeekend && input.holidays.has(date))
      return { date, kind: "holiday", season };
    return {
      date,
      kind: settings.weekendDays.includes(isoWeekday(date)) ? "weekend" : "weekday",
      season,
    };
  };
  const adjust = (m: Money, season: RateSeason | null) =>
    season === null ? m : m.add(m.percent(season.adjustmentPercent));
  const dailyRate = (d: Day) =>
    adjust(
      money(
        d.kind !== "weekday" && plan.weekendDailyMinor !== null
          ? plan.weekendDailyMinor
          : plan.dailyMinor,
      ),
      d.season,
    );
  const prorated = (rateMinor: number, days: number, period: number) =>
    money(Number(divideHalfEven(BigInt(rateMinor) * BigInt(days), BigInt(period))));
  const tierRate = (tier: "weekly" | "monthly") =>
    tier === "weekly" ? plan.weeklyMinor! : plan.monthlyMinor!;
  const dayValue = (tier: Exclude<RentalTier, "hourly">, d: Day) =>
    tier === "daily" ? dailyRate(d) : adjust(prorated(tierRate(tier), 1, PERIOD[tier]), d.season);
  const seasonText = (s: RateSeason | null) =>
    s === null
      ? ""
      : `, ${s.name} ${s.adjustmentPercent.startsWith("-") ? "" : "+"}${s.adjustmentPercent}%`;
  const rentalTax = plan.taxCode;

  const hourlyLine = (hours: number, d: Day): RawLine => {
    const rate = adjust(money(plan.hourlyMinor!), d.season);
    return {
      kind: "rental",
      refId: null,
      description: `Rental: ${plural(hours, "hour")} at ${rate.format()}${seasonText(d.season)}`,
      quantity: hours,
      unit: "hour",
      rate,
      amount: rate.times(hours),
      taxCode: rentalTax,
    };
  };

  /** The rental charge of `days` full days under a tier, with the extra hours if any. */
  const charge = (
    tier: Exclude<RentalTier, "hourly">,
    days: Day[],
    partial: Readonly<{ day: Day; hours: number }> | null,
  ): Charge => {
    const all = [...days];
    let hours: RawLine | null = null;
    if (partial !== null) {
      const byHour = plan.hourlyMinor === null ? null : hourlyLine(partial.hours, partial.day);
      if (byHour !== null && byHour.amount.compare(dayValue(tier, partial.day)) < 0) hours = byHour;
      else all.push(partial.day);
    }
    const groups = new Map<string, { days: Day[]; sample: Day }>();
    for (const d of all) {
      const key = tier === "daily" ? `${d.kind}|${d.season?.id ?? ""}` : (d.season?.id ?? "");
      const group = groups.get(key) ?? { days: [], sample: d };
      group.days.push(d);
      groups.set(key, group);
    }
    const lines: RawLine[] = [...groups.values()].map(({ days: grouped, sample }) => {
      const n = grouped.length;
      if (tier === "daily") {
        const rate = dailyRate(sample);
        const label = { weekday: "weekday", weekend: "weekend day", holiday: "holiday" }[
          sample.kind
        ];
        return {
          kind: "rental",
          refId: null,
          description: `Rental: ${plural(n, label)} at ${rate.format()}${seasonText(sample.season)}`,
          quantity: n,
          unit: "day",
          rate,
          amount: rate.times(n),
          taxCode: rentalTax,
        };
      }
      const rate = money(tierRate(tier));
      return {
        kind: "rental",
        refId: null,
        description: `Rental: ${plural(n, "day")} at the ${tier} rate (${rate.format()} for ${PERIOD[tier]} days)${seasonText(sample.season)}`,
        quantity: n,
        unit: "day",
        rate,
        amount: adjust(prorated(tierRate(tier), n, PERIOD[tier]), sample.season),
        taxCode: rentalTax,
      };
    });
    if (hours !== null) lines.push(hours);
    return {
      lines,
      amount: lines.reduce((sum, l) => sum.add(l.amount), money(0)),
      days: all.length,
      hours: hours?.quantity ?? 0,
    };
  };

  // --- the rental charge ---
  const fullDays = Math.floor(durationMinutes / DAY_MINUTES);
  const rest = durationMinutes - fullDays * DAY_MINUTES;
  const restHours = Math.ceil(rest / 60);
  let tier: RentalTier;
  let cappedBy: RentalQuote["cappedBy"] = null;
  let rental: Charge;

  if (fullDays === 0) {
    const day0 = dayAt(0);
    const hours = Math.max(restHours, plan.minHours);
    const byHour = plan.hourlyMinor === null ? null : hourlyLine(hours, day0);
    if (byHour !== null && byHour.amount.compare(dailyRate(day0)) < 0) {
      tier = "hourly";
      rental = { lines: [byHour], amount: byHour.amount, days: 0, hours };
    } else {
      tier = "daily";
      rental = charge("daily", [day0], null);
    }
  } else {
    const days = Array.from({ length: fullDays }, (_, k) => dayAt(k));
    const partial =
      rest > settings.graceMinutes ? { day: dayAt(fullDays), hours: restHours } : null;
    const tierDays = fullDays + (partial === null ? 0 : 1);
    tier =
      plan.monthlyMinor !== null && tierDays >= settings.monthlyFromDays
        ? "monthly"
        : plan.weeklyMinor !== null && tierDays >= settings.weeklyFromDays
          ? "weekly"
          : "daily";
    rental = charge(tier, days, partial);
    // Never more than one full period of a higher tier the rental fits in.
    const higher = (["weekly", "monthly"] as const).filter(
      (t) =>
        (tier === "daily" || (tier === "weekly" && t === "monthly")) &&
        (t === "weekly" ? plan.weeklyMinor : plan.monthlyMinor) !== null &&
        tierDays <= PERIOD[t],
    );
    for (const t of higher) {
      const period = charge(
        t,
        Array.from({ length: PERIOD[t] }, (_, k) => dayAt(k)),
        null,
      );
      if (period.amount.compare(rental.amount) < 0) {
        cappedBy = t;
        rental = {
          lines: [
            {
              kind: "rental",
              refId: null,
              description: `Rental: ${plural(tierDays, "day")}, charged as ${PERIOD[t]} days at the ${t} rate (${money(tierRate(t)).format()})`,
              quantity: tierDays,
              unit: "day",
              rate: money(tierRate(t)),
              amount: period.amount,
              taxCode: rentalTax,
            },
          ],
          amount: period.amount,
          days: tierDays,
          hours: 0,
        };
      }
    }
  }
  /** Days extras, the chauffeur and mileage are counted for (a short rental counts one). */
  const billingDays = Math.max(rental.days, 1);
  const computed = rental.amount;

  // --- agreed price, promo code, agent discount ---
  let rentalLines = rental.lines;
  let override: RentalQuote["discounts"]["override"] = null;
  if (input.override !== null) {
    if (input.promo !== null || input.discountPercent !== null)
      throw new RentalPricingError("An agreed price takes no promo code or discount");
    if (!Number.isSafeInteger(input.override.amountMinor) || input.override.amountMinor < 0)
      throw new RentalPricingError("The agreed price is zero or more");
    const agreed = money(input.override.amountMinor);
    override = { reason: input.override.reason, computed };
    rentalLines = [
      {
        kind: "rental",
        refId: null,
        description: `Rental: agreed price for ${rental.days > 0 ? plural(rental.days, "day") : plural(rental.hours, "hour")} (${input.override.reason})`,
        quantity: 1,
        unit: "rental",
        rate: agreed,
        amount: agreed,
        taxCode: rentalTax,
      },
    ];
  }
  const rentalCharge = rentalLines.reduce((sum, l) => sum.add(l.amount), money(0));

  let promo: RentalQuote["discounts"]["promo"] = null;
  if (input.promo !== null) {
    const p = input.promo;
    if (!p.active) throw new RentalPricingError(`Promo code ${p.code} is no longer valid`);
    if (
      (p.validFrom !== null && pickupDate < p.validFrom) ||
      (p.validTo !== null && pickupDate > p.validTo)
    )
      throw new RentalPricingError(
        `Promo code ${p.code} is not valid for a pickup on ${pickupDate}`,
      );
    if (p.maxUses !== null && p.usedCount >= p.maxUses)
      throw new RentalPricingError(`Promo code ${p.code} has been used up`);
    if (p.minDays !== null && billingDays < p.minDays)
      throw new RentalPricingError(
        `Promo code ${p.code} needs a rental of ${plural(p.minDays, "day")} or more`,
      );
    if (p.classIds.length > 0 && (input.classId === null || !p.classIds.includes(input.classId)))
      throw new RentalPricingError(`Promo code ${p.code} is not valid for this class`);
    const off =
      p.discountPercent !== null
        ? rentalCharge.percent(p.discountPercent)
        : money(p.discountMinor!);
    promo = { code: p.code, amount: off.compare(rentalCharge) > 0 ? rentalCharge : off };
  }
  let manual: RentalQuote["discounts"]["manual"] = null;
  if (input.discountPercent !== null) {
    assertPercent(input.discountPercent, 0, 100, "The discount");
    const base = promo === null ? rentalCharge : rentalCharge.subtract(promo.amount);
    manual = { percent: input.discountPercent, amount: base.percent(input.discountPercent) };
  }
  const discount = (promo?.amount ?? money(0)).add(manual?.amount ?? money(0));
  const discounts =
    discount.isZero() || rentalCharge.isZero()
      ? rentalLines.map(() => money(0))
      : discount.allocate(rentalLines.map((l) => l.amount.amountMinor));

  // --- everything else ---
  const others: RawLine[] = [];
  const add = (line: Omit<RawLine, "amount"> & { amount?: Money }) =>
    others.push({ ...line, amount: line.amount ?? line.rate.times(line.quantity) });

  if (input.chauffeur !== null) {
    const c = input.chauffeur;
    if (plan.chauffeurDailyMinor === null)
      throw new RentalPricingError(`Rate plan ${plan.code} offers no chauffeur`);
    if (!Number.isInteger(c.overnights) || c.overnights < 0 || c.overnights > billingDays)
      throw new RentalPricingError(`Overnights are between 0 and ${billingDays}`);
    if (!Number.isInteger(c.outOfTownDays) || c.outOfTownDays < 0 || c.outOfTownDays > billingDays)
      throw new RentalPricingError(`Out-of-town days are between 0 and ${billingDays}`);
    const fee = money(plan.chauffeurDailyMinor);
    add({
      kind: "chauffeur",
      refId: null,
      description: `Chauffeur: ${plural(billingDays, "day")} at ${fee.format()}`,
      quantity: billingDays,
      unit: "day",
      rate: fee,
      taxCode: rentalTax,
    });
    if (c.overnights > 0) {
      if (plan.chauffeurOvernightMinor === null)
        throw new RentalPricingError(`Rate plan ${plan.code} has no overnight allowance`);
      const rate = money(plan.chauffeurOvernightMinor);
      add({
        kind: "chauffeur_overnight",
        refId: null,
        description: `Chauffeur overnight allowance: ${plural(c.overnights, "night")} at ${rate.format()}`,
        quantity: c.overnights,
        unit: "night",
        rate,
        taxCode: rentalTax,
      });
    }
    if (c.outOfTownDays > 0) {
      if (plan.chauffeurOutOfTownMinor === null)
        throw new RentalPricingError(`Rate plan ${plan.code} has no out-of-town allowance`);
      const rate = money(plan.chauffeurOutOfTownMinor);
      add({
        kind: "chauffeur_out_of_town",
        refId: null,
        description: `Chauffeur out-of-town allowance: ${plural(c.outOfTownDays, "day")} at ${rate.format()}`,
        quantity: c.outOfTownDays,
        unit: "day",
        rate,
        taxCode: rentalTax,
      });
    }
  }

  const seen = new Set<string>();
  for (const { extra, quantity } of input.extras) {
    if (seen.has(extra.id)) throw new RentalPricingError(`${extra.name} is listed twice`);
    seen.add(extra.id);
    if (!extra.active) throw new RentalPricingError(`${extra.name} is no longer offered`);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > extra.maxQuantity)
      throw new RentalPricingError(`${extra.name}: between 1 and ${extra.maxQuantity}`);
    if (
      extra.classIds.length > 0 &&
      (input.classId === null || !extra.classIds.includes(input.classId))
    )
      throw new RentalPricingError(`${extra.name} is not offered for this class`);
    const price = money(extra.priceMinor);
    const each = quantity > 1 ? ` × ${quantity}` : "";
    if (extra.charge === "per_rental") {
      add({
        kind: "extra",
        refId: extra.id,
        description: `${extra.name}${each}`,
        quantity,
        unit: "rental",
        rate: price,
        taxCode: extra.taxCode,
      });
      continue;
    }
    let perUnit = price.times(billingDays);
    let capped = "";
    if (extra.maxChargeMinor !== null && perUnit.amountMinor > extra.maxChargeMinor) {
      perUnit = money(extra.maxChargeMinor);
      capped = ` (capped at ${perUnit.format()})`;
    }
    add({
      kind: "extra",
      refId: extra.id,
      description: `${extra.name}${each}: ${plural(billingDays, "day")} at ${price.format()}${capped}`,
      quantity,
      unit: "day",
      rate: price,
      amount: perUnit.times(quantity),
      taxCode: extra.taxCode,
    });
  }

  const zone = (z: RentalZone | null, what: string) => {
    if (z !== null && !z.active)
      throw new RentalPricingError(`${what}: ${z.name} is no longer served`);
    return z;
  };
  const delivery = zone(input.delivery, "Delivery");
  if (delivery !== null && delivery.deliveryFeeMinor > 0)
    add({
      kind: "delivery",
      refId: delivery.id,
      description: `Delivery to ${delivery.name}`,
      quantity: 1,
      unit: "rental",
      rate: money(delivery.deliveryFeeMinor),
      taxCode: rentalTax,
    });
  const collection = zone(input.collection, "Collection");
  if (collection !== null && collection.collectionFeeMinor > 0)
    add({
      kind: "collection",
      refId: collection.id,
      description: `Collection from ${collection.name}`,
      quantity: 1,
      unit: "rental",
      rate: money(collection.collectionFeeMinor),
      taxCode: rentalTax,
    });
  const destination = zone(input.destination, "Destination");
  if (destination !== null && destination.outOfTownDailyMinor > 0) {
    const rate = money(destination.outOfTownDailyMinor);
    add({
      kind: "out_of_town",
      refId: destination.id,
      description: `Out of town (${destination.name}): ${plural(billingDays, "day")} at ${rate.format()}`,
      quantity: billingDays,
      unit: "day",
      rate,
      taxCode: rentalTax,
    });
  }

  const mileage: RentalQuote["mileage"] =
    plan.includedKmPerDay === null
      ? { unlimited: true }
      : {
          unlimited: false,
          includedKm: plan.includedKmPerDay * billingDays,
          extraKm: money(plan.extraKmMinor!),
        };
  if (input.estimatedKm !== null) {
    if (!Number.isInteger(input.estimatedKm) || input.estimatedKm < 0)
      throw new RentalPricingError("The estimated distance is a whole number of km");
    if (!mileage.unlimited && input.estimatedKm > mileage.includedKm) {
      const km = input.estimatedKm - mileage.includedKm;
      add({
        kind: "extra_km_estimate",
        refId: null,
        description: `Estimated extra distance: ${km} km beyond ${mileage.includedKm} km at ${mileage.extraKm.format()} (charged on the odometer at return)`,
        quantity: km,
        unit: "km",
        rate: mileage.extraKm,
        taxCode: rentalTax,
      });
    }
  }

  // --- tax ---
  const taxCode = (explicit: string | null) => salesTaxCode(input.tax, explicit);
  const priced = (raw: RawLine, lineDiscount: Money): QuoteLine => {
    const after = raw.amount.subtract(lineDiscount);
    const code = taxCode(raw.taxCode);
    if (code === null)
      return {
        ...raw,
        discount: lineDiscount,
        net: after,
        taxCode: null,
        taxComponents: [],
        tax: money(0),
        total: after,
      };
    const taxed = code.apply(after, pickupDate, input.tax.pricesIncludeTax);
    return {
      ...raw,
      discount: lineDiscount,
      net: taxed.net,
      taxCode: taxed.code,
      taxComponents: taxed.components,
      tax: taxed.tax,
      total: taxed.gross,
    };
  };
  const lines = [
    ...rentalLines.map((l, i) => priced(l, discounts[i]!)),
    ...others.map((l) => priced(l, money(0))),
  ];

  const sum = (pick: (l: QuoteLine) => Money) => lines.reduce((s, l) => s.add(pick(l)), money(0));
  const components = new Map<string, { key: string; name: string; amount: Money }>();
  for (const c of lines.flatMap((l) => l.taxComponents)) {
    const current = components.get(c.key);
    components.set(c.key, {
      key: c.key,
      name: c.name,
      amount: (current?.amount ?? money(0)).add(c.amount),
    });
  }
  return {
    currency,
    pickupAt: input.pickupAt,
    returnAt: input.returnAt,
    durationMinutes,
    tier,
    cappedBy,
    days: rental.days,
    hours: rental.hours,
    plan: { id: plan.id, code: plan.code, name: plan.name },
    lines,
    mileage,
    discounts: { promo, manual, override },
    totals: {
      subtotal: sum((l) => l.amount),
      discount: sum((l) => l.discount),
      net: sum((l) => l.net),
      tax: sum((l) => l.tax),
      total: sum((l) => l.total),
      taxComponents: [...components.values()],
    },
  };
}

/** The sales tax code a line is taxed with (none when the business is not registered). */
export function salesTaxCode(tax: QuoteInput["tax"], explicit: string | null): TaxCode | null {
  if (!tax.registered) return null;
  const key = explicit ?? tax.defaultCode;
  if (key === null) return null;
  const code = tax.codes.get(key);
  if (code === undefined || !code.active || !code.snapshot().appliesTo.includes("sales"))
    throw new RentalPricingError(`${key} is not an active sales tax code`);
  return code;
}

/** One amount taxed like the rental (a refuelling or cleaning charge at check-in). */
export function taxedLikeRental(
  amount: Money,
  tax: QuoteInput["tax"],
  explicit: string | null,
  date: string,
): Readonly<{ net: Money; tax: Money; total: Money }> {
  const code = salesTaxCode(tax, explicit);
  if (code === null) return { net: amount, tax: Money.zero(amount.currency), total: amount };
  const taxed = code.apply(amount, date, tax.pricesIncludeTax);
  return { net: taxed.net, tax: taxed.tax, total: taxed.gross };
}
