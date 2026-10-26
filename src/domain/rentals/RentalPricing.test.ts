import { describe, expect, it } from "vitest";
import { TaxCode } from "../tax/TaxCode.js";
import { quoteRental, selectRatePlan, type QuoteInput } from "./RentalPricing.js";
import {
  DEFAULT_RENTAL_SETTINGS,
  validateRatePlan,
  validateSettings,
  type PromoCode,
  type RatePlan,
  type RentalExtra,
  type RentalZone,
} from "./RentalRates.js";

const PLAN: RatePlan = {
  id: "plan-suv",
  code: "SUV-STD",
  name: "SUV standard",
  classId: "class-suv",
  vehicleId: null,
  branchId: null,
  customerId: null,
  currency: "GHS",
  hourlyMinor: 4_000,
  dailyMinor: 30_000,
  weekendDailyMinor: 35_000,
  weeklyMinor: 180_000,
  monthlyMinor: 600_000,
  minHours: 3,
  includedKmPerDay: 200,
  extraKmMinor: 150,
  chauffeurDailyMinor: 15_000,
  chauffeurOvernightMinor: 10_000,
  chauffeurOutOfTownMinor: 5_000,
  taxCode: null,
  validFrom: null,
  validTo: null,
  seasons: [
    {
      id: "xmas",
      name: "Christmas",
      startsOn: "2026-12-20",
      endsOn: "2026-12-31",
      adjustmentPercent: "25",
    },
  ],
  active: true,
  notes: null,
};

const extra = (overrides: Partial<RentalExtra>): RentalExtra => ({
  id: "x",
  code: "X",
  name: "Extra",
  description: null,
  category: "equipment",
  charge: "per_day",
  priceMinor: 2_000,
  maxChargeMinor: null,
  maxQuantity: 2,
  taxCode: null,
  classIds: [],
  sort: 0,
  active: true,
  ...overrides,
});
const CHILD_SEAT = extra({ id: "seat", code: "SEAT", name: "Child seat", maxChargeMinor: 8_000 });
const GPS = extra({ id: "gps", code: "GPS", name: "GPS", charge: "per_rental", priceMinor: 5_000 });

const zone = (overrides: Partial<RentalZone>): RentalZone => ({
  id: "z",
  name: "Zone",
  deliveryFeeMinor: 0,
  collectionFeeMinor: 0,
  outOfTownDailyMinor: 0,
  active: true,
  ...overrides,
});
const AIRPORT = zone({
  id: "acc",
  name: "Airport",
  deliveryFeeMinor: 5_000,
  collectionFeeMinor: 4_000,
});
const KUMASI = zone({ id: "ksi", name: "Kumasi", outOfTownDailyMinor: 10_000 });

const promo = (overrides: Partial<PromoCode>): PromoCode => ({
  id: "p",
  code: "EASTER10",
  description: null,
  discountPercent: "10",
  discountMinor: null,
  validFrom: null,
  validTo: null,
  minDays: null,
  maxUses: null,
  usedCount: 0,
  classIds: [],
  active: true,
  ...overrides,
});

const VAT = TaxCode.create({
  code: "VAT_STANDARD",
  name: "Standard rate",
  kind: "standard",
  appliesTo: ["sales", "purchases"],
  components: [
    {
      key: "vat",
      name: "VAT",
      rate: "15",
      base: "net",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
    },
    {
      key: "nhil",
      name: "NHIL",
      rate: "2.5",
      base: "net",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
    },
    {
      key: "getfund",
      name: "GETFund",
      rate: "2.5",
      base: "net",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
    },
  ],
  active: true,
});

const at = (iso: string) => new Date(iso);
const quote = (from: string, to: string, overrides: Partial<QuoteInput> = {}) =>
  quoteRental({
    pickupAt: at(from),
    returnAt: at(to),
    localDate: (d) => d.toISOString().slice(0, 10),
    plan: PLAN,
    classId: "class-suv",
    settings: DEFAULT_RENTAL_SETTINGS,
    holidays: new Set(),
    extras: [],
    chauffeur: null,
    delivery: null,
    collection: null,
    destination: null,
    estimatedKm: null,
    promo: null,
    discountPercent: null,
    override: null,
    tax: { registered: false, pricesIncludeTax: false, defaultCode: null, codes: new Map() },
    ...overrides,
  });

// 2026-11-02 is a Monday; Accra is UTC, so local dates are the UTC dates.
const MON = "2026-11-02T09:00:00Z";

/**
 * Price fixtures (docs/30 P5-1 exit: "price quotes match fixtures"). Each row is worked by hand
 * from the SUV plan above: ₵300 a weekday, ₵350 a weekend day, ₵40 an hour (3 h minimum),
 * ₵1,800 a week, ₵6,000 for 30 days; Christmas +25 %.
 */
const FIXTURES: readonly Readonly<{
  name: string;
  from: string;
  to: string;
  input?: Partial<QuoteInput>;
  tier: string;
  days: number;
  hours: number;
  totalMinor: number;
  lines?: readonly string[];
}>[] = [
  {
    name: "three weekdays",
    from: MON,
    to: "2026-11-05T09:00:00Z",
    tier: "daily",
    days: 3,
    hours: 0,
    totalMinor: 90_000,
    lines: ["Rental: 3 weekdays at ₵300.00"],
  },
  {
    name: "a weekend at the weekend rate",
    from: "2026-11-06T09:00:00Z",
    to: "2026-11-09T09:00:00Z",
    tier: "daily",
    days: 3,
    hours: 0,
    totalMinor: 100_000,
    lines: ["Rental: 1 weekday at ₵300.00", "Rental: 2 weekend days at ₵350.00"],
  },
  {
    name: "late within the grace",
    from: MON,
    to: "2026-11-04T09:45:00Z",
    tier: "daily",
    days: 2,
    hours: 0,
    totalMinor: 60_000,
  },
  {
    name: "late by hours, cheaper than a day",
    from: MON,
    to: "2026-11-04T11:30:00Z",
    tier: "daily",
    days: 2,
    hours: 3,
    totalMinor: 72_000,
    lines: ["Rental: 2 weekdays at ₵300.00", "Rental: 3 hours at ₵40.00"],
  },
  {
    name: "late by hours, a day is cheaper",
    from: MON,
    to: "2026-11-04T18:00:00Z",
    tier: "daily",
    days: 3,
    hours: 0,
    totalMinor: 90_000,
  },
  {
    name: "a few hours",
    from: MON,
    to: "2026-11-02T13:30:00Z",
    tier: "hourly",
    days: 0,
    hours: 5,
    totalMinor: 20_000,
  },
  {
    name: "one hour, charged the minimum",
    from: MON,
    to: "2026-11-02T10:00:00Z",
    tier: "hourly",
    days: 0,
    hours: 3,
    totalMinor: 12_000,
  },
  {
    name: "a working day, a day is cheaper",
    from: MON,
    to: "2026-11-02T17:00:00Z",
    tier: "daily",
    days: 1,
    hours: 0,
    totalMinor: 30_000,
  },
  {
    name: "six days capped at the weekly rate",
    from: MON,
    to: "2026-11-08T09:00:00Z",
    tier: "daily",
    days: 6,
    hours: 0,
    totalMinor: 180_000,
    lines: ["Rental: 6 days, charged as 7 days at the weekly rate (₵1,800.00)"],
  },
  {
    name: "ten days at the weekly rate",
    from: MON,
    to: "2026-11-12T09:00:00Z",
    tier: "weekly",
    days: 10,
    hours: 0,
    totalMinor: 257_143,
    lines: ["Rental: 10 days at the weekly rate (₵1,800.00 for 7 days)"],
  },
  {
    name: "27 days capped at the monthly rate",
    from: MON,
    to: "2026-11-29T09:00:00Z",
    tier: "weekly",
    days: 27,
    hours: 0,
    totalMinor: 600_000,
  },
  {
    name: "28 days at the monthly rate",
    from: MON,
    to: "2026-11-30T09:00:00Z",
    tier: "monthly",
    days: 28,
    hours: 0,
    totalMinor: 560_000,
  },
  {
    name: "Christmas season",
    from: "2026-12-21T09:00:00Z",
    to: "2026-12-24T09:00:00Z",
    tier: "daily",
    days: 3,
    hours: 0,
    totalMinor: 112_500,
    lines: ["Rental: 3 weekdays at ₵375.00, Christmas +25%"],
  },
  {
    name: "a public holiday at the weekend rate",
    from: MON,
    to: "2026-11-05T09:00:00Z",
    input: { holidays: new Set(["2026-11-03"]) },
    tier: "daily",
    days: 3,
    hours: 0,
    totalMinor: 95_000,
    lines: ["Rental: 2 weekdays at ₵300.00", "Rental: 1 holiday at ₵350.00"],
  },
  {
    name: "extras per day (capped) and per rental",
    from: MON,
    to: "2026-11-07T09:00:00Z",
    input: {
      extras: [
        { extra: CHILD_SEAT, quantity: 2 },
        { extra: GPS, quantity: 1 },
      ],
    },
    tier: "daily",
    days: 5,
    hours: 0,
    totalMinor: 171_000,
    lines: [
      "Rental: 5 weekdays at ₵300.00",
      "Child seat × 2: 5 days at ₵20.00 (capped at ₵80.00)",
      "GPS",
    ],
  },
  {
    name: "a chauffeur with allowances",
    from: MON,
    to: "2026-11-04T09:00:00Z",
    input: { chauffeur: { overnights: 1, outOfTownDays: 2 } },
    tier: "daily",
    days: 2,
    hours: 0,
    totalMinor: 110_000,
  },
  {
    name: "delivery, collection and out of town",
    from: MON,
    to: "2026-11-04T09:00:00Z",
    input: { delivery: AIRPORT, collection: AIRPORT, destination: KUMASI },
    tier: "daily",
    days: 2,
    hours: 0,
    totalMinor: 89_000,
    lines: [
      "Rental: 2 weekdays at ₵300.00",
      "Delivery to Airport",
      "Collection from Airport",
      "Out of town (Kumasi): 2 days at ₵100.00",
    ],
  },
  {
    name: "promo then agent discount",
    from: MON,
    to: "2026-11-05T09:00:00Z",
    input: { promo: promo({}), discountPercent: "5" },
    tier: "daily",
    days: 3,
    hours: 0,
    totalMinor: 76_950,
  },
  {
    name: "a promo amount never exceeds the rental",
    from: MON,
    to: "2026-11-05T09:00:00Z",
    input: { promo: promo({ discountPercent: null, discountMinor: 100_000 }) },
    tier: "daily",
    days: 3,
    hours: 0,
    totalMinor: 0,
  },
  {
    name: "an agreed price",
    from: MON,
    to: "2026-11-04T09:00:00Z",
    input: { override: { amountMinor: 50_000, reason: "Returning customer" } },
    tier: "daily",
    days: 2,
    hours: 0,
    totalMinor: 50_000,
    lines: ["Rental: agreed price for 2 days (Returning customer)"],
  },
  {
    name: "estimated extra distance",
    from: MON,
    to: "2026-11-05T09:00:00Z",
    input: { estimatedKm: 750 },
    tier: "daily",
    days: 3,
    hours: 0,
    totalMinor: 112_500,
  },
  {
    name: "VAT on top",
    from: MON,
    to: "2026-11-05T09:00:00Z",
    input: {
      tax: {
        registered: true,
        pricesIncludeTax: false,
        defaultCode: "VAT_STANDARD",
        codes: new Map([["VAT_STANDARD", VAT]]),
      },
    },
    tier: "daily",
    days: 3,
    hours: 0,
    totalMinor: 108_000,
  },
  {
    name: "VAT included in the rates",
    from: MON,
    to: "2026-11-05T09:00:00Z",
    input: {
      tax: {
        registered: true,
        pricesIncludeTax: true,
        defaultCode: "VAT_STANDARD",
        codes: new Map([["VAT_STANDARD", VAT]]),
      },
    },
    tier: "daily",
    days: 3,
    hours: 0,
    totalMinor: 90_000,
  },
];

describe("rental price fixtures", () => {
  for (const f of FIXTURES) {
    it(f.name, () => {
      const q = quote(f.from, f.to, f.input);
      expect({
        tier: q.tier,
        days: q.days,
        hours: q.hours,
        total: q.totals.total.amountMinor,
      }).toEqual({
        tier: f.tier,
        days: f.days,
        hours: f.hours,
        total: f.totalMinor,
      });
      if (f.lines !== undefined) expect(q.lines.map((l) => l.description)).toEqual(f.lines);
      // The parts always add up.
      const sum = q.lines.reduce((s, l) => s + l.total.amountMinor, 0);
      expect(sum).toBe(q.totals.total.amountMinor);
      expect(q.totals.subtotal.amountMinor - q.totals.discount.amountMinor).toBe(
        q.lines.reduce((s, l) => s + l.amount.amountMinor - l.discount.amountMinor, 0),
      );
    });
  }
});

describe("quote details", () => {
  it("records the discounts, spread over the rental lines", () => {
    const q = quote("2026-11-06T09:00:00Z", "2026-11-09T09:00:00Z", {
      promo: promo({}),
      discountPercent: "5",
      extras: [{ extra: GPS, quantity: 1 }],
    });
    // ₵1,000 rental: 10 % = ₵100, then 5 % of ₵900 = ₵45; GPS takes no discount.
    expect(q.discounts.promo?.amount.amountMinor).toBe(10_000);
    expect(q.discounts.manual?.amount.amountMinor).toBe(4_500);
    expect(q.lines.map((l) => l.discount.amountMinor)).toEqual([4_350, 10_150, 0]);
    expect(q.totals.total.amountMinor).toBe(100_000 - 14_500 + 5_000);
  });

  it("works VAT back out of tax-inclusive rates, the levies adding up", () => {
    const q = quote(MON, "2026-11-05T09:00:00Z", {
      tax: {
        registered: true,
        pricesIncludeTax: true,
        defaultCode: "VAT_STANDARD",
        codes: new Map([["VAT_STANDARD", VAT]]),
      },
    });
    expect(q.totals.net.amountMinor).toBe(75_000);
    expect(q.totals.tax.amountMinor).toBe(15_000);
    expect(q.totals.taxComponents.map((c) => [c.key, c.amount.amountMinor])).toEqual([
      ["vat", 11_250],
      ["nhil", 1_875],
      ["getfund", 1_875],
    ]);
  });

  it("charges no tax for a business not registered, whatever the plan says", () => {
    const q = quote(MON, "2026-11-03T09:00:00Z", { plan: { ...PLAN, taxCode: "VAT_STANDARD" } });
    expect(q.totals.tax.isZero()).toBe(true);
    expect(q.lines[0]!.taxCode).toBeNull();
  });

  it("states the mileage allowance and keeps the agreed price's computed charge", () => {
    const q = quote(MON, "2026-11-04T09:00:00Z", {
      override: { amountMinor: 50_000, reason: "Loyal" },
    });
    expect(q.mileage).toMatchObject({ unlimited: false, includedKm: 400 });
    expect(q.discounts.override?.computed.amountMinor).toBe(60_000);
    expect(
      quote(MON, "2026-11-04T09:00:00Z", {
        plan: { ...PLAN, includedKmPerDay: null, extraKmMinor: null },
      }).mileage,
    ).toEqual({ unlimited: true });
  });

  it("charges every day by its date when a rental crosses into a season", () => {
    const q = quote("2026-12-18T09:00:00Z", "2026-12-22T09:00:00Z");
    // Fri ₵300, Sat ₵350, Sun 20 Dec ₵437.50, Mon 21 Dec ₵375.
    expect(q.totals.total.amountMinor).toBe(30_000 + 35_000 + 43_750 + 37_500);
  });

  it("charges a plan without hourly rate a day for the time past the grace", () => {
    const daily = { ...PLAN, hourlyMinor: null };
    expect(quote(MON, "2026-11-04T11:00:00Z", { plan: daily }).totals.total.amountMinor).toBe(
      90_000,
    );
    expect(quote(MON, "2026-11-02T12:00:00Z", { plan: daily }).tier).toBe("daily");
  });
});

describe("refusals", () => {
  const refuses = (overrides: Partial<QuoteInput>, message: RegExp, to = "2026-11-05T09:00:00Z") =>
    expect(() => quote(MON, to, overrides)).toThrow(message);

  it("refuses impossible times and unusable plans", () => {
    expect(() => quote(MON, MON)).toThrow(/after the pickup/);
    refuses({ plan: { ...PLAN, active: false } }, /not active/);
    refuses({ plan: { ...PLAN, validTo: "2026-10-31" } }, /not valid on 2026-11-02/);
  });

  it("refuses promo codes that do not apply", () => {
    refuses({ promo: promo({ maxUses: 5, usedCount: 5 }) }, /used up/);
    refuses({ promo: promo({ minDays: 7 }) }, /7 days or more/);
    refuses({ promo: promo({ classIds: ["class-eco"] }) }, /not valid for this class/);
    refuses({ promo: promo({ validFrom: "2026-12-01" }) }, /not valid for a pickup/);
    refuses({ override: { amountMinor: 1, reason: "x" }, promo: promo({}) }, /agreed price/);
  });

  it("refuses extras, chauffeurs and tax codes that cannot be given", () => {
    refuses({ extras: [{ extra: CHILD_SEAT, quantity: 3 }] }, /between 1 and 2/);
    refuses(
      { extras: [{ extra: { ...GPS, classIds: ["class-eco"] }, quantity: 1 }] },
      /not offered for this class/,
    );
    refuses(
      {
        extras: [
          { extra: GPS, quantity: 1 },
          { extra: GPS, quantity: 1 },
        ],
      },
      /twice/,
    );
    refuses(
      {
        chauffeur: { overnights: 0, outOfTownDays: 0 },
        plan: {
          ...PLAN,
          chauffeurDailyMinor: null,
          chauffeurOvernightMinor: null,
          chauffeurOutOfTownMinor: null,
        },
      },
      /no chauffeur/,
    );
    refuses({ chauffeur: { overnights: 4, outOfTownDays: 0 } }, /Overnights/);
    refuses({ delivery: { ...AIRPORT, active: false } }, /no longer served/);
    refuses(
      {
        tax: {
          registered: true,
          pricesIncludeTax: false,
          defaultCode: "VAT_STANDARD",
          codes: new Map(),
        },
      },
      /not an active sales tax code/,
    );
    refuses({ discountPercent: "120" }, /between 0 and 100/);
  });
});

describe("choosing the rate plan", () => {
  const plans: RatePlan[] = [
    PLAN,
    { ...PLAN, id: "branch", code: "SUV-KSI", branchId: "kumasi" },
    { ...PLAN, id: "vehicle", code: "SUV-V8", classId: null, vehicleId: "v8" },
    { ...PLAN, id: "corporate", code: "SUV-MTN", customerId: "mtn" },
    { ...PLAN, id: "old", code: "SUV-OLD", validTo: "2026-01-31" },
  ];
  const pick = (q: Partial<Parameters<typeof selectRatePlan>[1]>) =>
    selectRatePlan(plans, {
      classId: "class-suv",
      vehicleId: null,
      branchId: "accra",
      customerId: null,
      date: "2026-11-02",
      ...q,
    })?.id;

  it("prefers the customer's, then the vehicle's, then the branch's plan", () => {
    expect(pick({})).toBe("plan-suv");
    expect(pick({ branchId: "kumasi" })).toBe("branch");
    expect(pick({ vehicleId: "v8", branchId: "kumasi" })).toBe("vehicle");
    expect(pick({ vehicleId: "v8", customerId: "mtn" })).toBe("corporate");
    expect(pick({ classId: "class-eco" })).toBeUndefined();
  });
});

describe("rate validation", () => {
  it("refuses overlapping seasons, half-set mileage and bad settings", () => {
    expect(() =>
      validateRatePlan({
        ...PLAN,
        seasons: [
          ...PLAN.seasons,
          {
            id: "s2",
            name: "New year",
            startsOn: "2026-12-31",
            endsOn: "2027-01-02",
            adjustmentPercent: "10",
          },
        ],
      }),
    ).toThrow(/overlap/);
    expect(() => validateRatePlan({ ...PLAN, extraKmMinor: null })).toThrow(/Limited mileage/);
    expect(() => validateRatePlan({ ...PLAN, vehicleId: "v1" })).toThrow(
      /either a class or one vehicle/,
    );
    expect(() => validateSettings({ ...DEFAULT_RENTAL_SETTINGS, weekendDays: [0] })).toThrow(
      /ISO weekdays/,
    );
    expect(
      validateSettings({ ...DEFAULT_RENTAL_SETTINGS, weekendDays: [7, 5, 7] }).weekendDays,
    ).toEqual([5, 7]);
  });
});
