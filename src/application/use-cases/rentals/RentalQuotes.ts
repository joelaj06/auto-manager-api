import { parseDecimal, pow10 } from "../../../domain/money/Decimal.js";
import { Money } from "../../../domain/money/Money.js";
import {
  quoteRental,
  RentalPricingError,
  selectRatePlan,
  type RentalQuote,
} from "../../../domain/rentals/RentalPricing.js";
import { TaxCode } from "../../../domain/tax/TaxCode.js";
import type { AuthorizationPolicy } from "../../authorization/AuthorizationPolicy.js";
import type { Principal } from "../../authorization/Principal.js";
import { PermissionDeniedError } from "../../errors/AuthErrors.js";
import type { IPartyDirectory } from "../../ports/IFinanceRecords.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IRentalRates } from "../../ports/IRentalRates.js";
import type { ITenantReferenceData } from "../../ports/IReferenceData.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { TenantCalendar } from "../../services/TenantCalendar.js";
import { localDateTime } from "../../services/TenantLocalTime.js";
import type { VehicleAccess } from "../vehicles/VehicleAccess.js";
import { RentalRateNotFoundError } from "./RentalRateAdministration.js";

export type QuoteRequest = Readonly<{
  pickupAt: Date;
  returnAt: Date;
  /** Book a class (assign a vehicle at check-out), or price one vehicle. */
  classId?: string | null;
  vehicleId?: string | null;
  /** The pickup branch (defaults to the vehicle's, or the caller's default branch). */
  branchId?: string | null;
  customerId?: string | null;
  /** Price with this plan instead of the one chosen by the rules. */
  ratePlanId?: string | null;
  extras?: readonly Readonly<{ extraId: string; quantity: number }>[];
  chauffeur?: Readonly<{ overnights?: number; outOfTownDays?: number }> | null;
  deliveryZoneId?: string | null;
  collectionZoneId?: string | null;
  destinationZoneId?: string | null;
  estimatedKm?: number | null;
  promoCode?: string | null;
  discountPercent?: string | null;
  override?: Readonly<{ amount: string; reason: string }> | null;
}>;

export type QuotedRental = RentalQuote &
  Readonly<{
    branchId: string;
    classId: string | null;
    vehicleId: string | null;
    customerId: string | null;
    quotedAt: Date;
  }>;

/** Basis points of a percent (exact, for comparing limits). */
const bps = (percent: string) => {
  const p = parseDecimal(percent);
  return (p.units * 10_000n) / pow10(p.scale);
};

/**
 * Prices a rental (docs/07 §4, §12 `POST /rentals/quotes`): finds the class, the rate plan by
 * its rules, the extras, zones and promo code, checks the caller may give the discount or agree
 * a price, and runs the pricing service. Nothing is stored: the result is the snapshot a booking
 * keeps (P5-3). Promo code uses are counted when a booking uses one, not when it is quoted.
 */
export class RentalQuotes {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      rates: IRentalRates;
      vehicleAccess: VehicleAccess;
      parties: IPartyDirectory;
      reference: ITenantReferenceData;
      organisation: IOrganisationSettings;
      policy: AuthorizationPolicy;
      clock: { now(): Date };
    }>,
  ) {}

  quote(actor: Principal, request: QuoteRequest): Promise<QuotedRental> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const { rates } = deps;
      const organisation = await deps.organisation.get();
      const localDate = (instant: Date) => localDateTime(instant, organisation.timezone).date;

      // The vehicle (and its class and branch), or a class booked at a branch.
      let vehicleId: string | null = null;
      let classId = request.classId ?? null;
      let branchId: string;
      if (request.vehicleId !== undefined && request.vehicleId !== null) {
        const vehicle = await deps.vehicleAccess.reach(actor, request.vehicleId, "rentals.view");
        vehicleId = vehicle.id;
        classId = (await rates.vehicleClassId(vehicle.id)) ?? classId;
        branchId = request.branchId ?? vehicle.branchId;
      } else {
        if (classId === null) throw new RentalPricingError("Choose a class or a vehicle to price");
        branchId =
          request.branchId ?? (await deps.vehicleAccess.defaultBranch(actor, "rentals.view"));
      }
      await deps.vehicleAccess.branch(actor, "rentals.view", branchId);
      if (classId !== null) {
        const vehicleClass = await rates.vehicleClass(classId);
        if (vehicleClass === null) throw new RentalRateNotFoundError("Class");
        if (!vehicleClass.active)
          throw new RentalPricingError(`${vehicleClass.name} is not rented any more`);
      }
      const customerId = request.customerId ?? null;
      if (customerId !== null && (await deps.parties.find("customer", customerId)) === null)
        throw new RentalRateNotFoundError("Customer");

      const pickupDate = localDate(request.pickupAt);
      let plan;
      if (request.ratePlanId !== undefined && request.ratePlanId !== null) {
        plan = await rates.plan(request.ratePlanId);
        if (plan === null) throw new RentalRateNotFoundError("Rate plan");
        if (plan.vehicleId !== null ? plan.vehicleId !== vehicleId : plan.classId !== classId)
          throw new RentalPricingError(`Rate plan ${plan.code} is for another class or vehicle`);
        if (plan.customerId !== null && plan.customerId !== customerId)
          throw new RentalPricingError(`Rate plan ${plan.code} is another customer's rate`);
      } else {
        const candidates = [
          ...(classId === null ? [] : await rates.plans({ classId })),
          ...(vehicleId === null ? [] : await rates.plans({ vehicleId })),
        ];
        plan = selectRatePlan(candidates, {
          classId,
          vehicleId,
          branchId,
          customerId,
          date: pickupDate,
        });
        if (plan === null)
          throw new RentalPricingError(`No rate plan prices this rental on ${pickupDate}`);
      }

      const extras = await Promise.all(
        (request.extras ?? []).map(async ({ extraId, quantity }) => {
          const extra = await rates.extra(extraId);
          if (extra === null) throw new RentalRateNotFoundError("Extra");
          return { extra, quantity };
        }),
      );
      const zone = async (id: string | null | undefined) => {
        if (id === undefined || id === null) return null;
        const found = await rates.zone(id);
        if (found === null) throw new RentalRateNotFoundError("Zone");
        return found;
      };
      let promo = null;
      if (request.promoCode !== undefined && request.promoCode !== null) {
        promo = await rates.promoByCode(request.promoCode.trim().toUpperCase());
        if (promo === null)
          throw new RentalPricingError(`${request.promoCode} is not a promo code of ours`);
      }

      // Discounts within the caller's limit; an agreed price needs its own permission.
      const discountPercent = request.discountPercent ?? null;
      const settings = await rates.settings();
      if (discountPercent !== null && bps(discountPercent) > 0n) {
        deps.policy.require(actor, "rentals.discount.apply", { branchId });
        const limit = deps.policy.limit(actor, "rentals.discount.apply", "max_percent");
        const max =
          limit === undefined ? bps(settings.maxDiscountPercent) : BigInt(Math.round(limit * 100));
        if (
          bps(discountPercent) > max &&
          !deps.policy.decide(actor, "rentals.price.override", { branchId }).allowed
        )
          throw new RentalPricingError(
            `You may give up to ${Number(max) / 100}% off; ask someone who can agree prices`,
          );
      }
      let override = null;
      if (request.override !== undefined && request.override !== null) {
        if (!deps.policy.decide(actor, "rentals.price.override", { branchId }).allowed)
          throw new PermissionDeniedError("rentals.price.override");
        override = {
          amountMinor: Money.parse(request.override.amount, plan.currency).amountMinor,
          reason: request.override.reason.trim(),
        };
      }

      const tax = await deps.organisation.taxSettings();
      const codes = new Map(
        (await deps.reference.taxCodes()).map((props) => [props.code, TaxCode.create(props)]),
      );
      const returnDate = localDate(request.returnAt);
      const holidays = await rates.holidays(pickupDate, TenantCalendar.addDays(returnDate, 1));
      const quote = quoteRental({
        pickupAt: request.pickupAt,
        returnAt: request.returnAt,
        localDate,
        plan,
        classId,
        settings,
        holidays: new Set(holidays.map((h) => h.date)),
        extras,
        chauffeur:
          request.chauffeur === undefined || request.chauffeur === null
            ? null
            : {
                overnights: request.chauffeur.overnights ?? 0,
                outOfTownDays: request.chauffeur.outOfTownDays ?? 0,
              },
        delivery: await zone(request.deliveryZoneId),
        collection: await zone(request.collectionZoneId),
        destination: await zone(request.destinationZoneId),
        estimatedKm: request.estimatedKm ?? null,
        promo,
        discountPercent:
          discountPercent !== null && bps(discountPercent) > 0n ? discountPercent : null,
        override,
        tax: {
          registered: tax.scheme !== "not_registered",
          pricesIncludeTax: tax.pricesIncludeTax,
          defaultCode: tax.defaultSalesTaxCode,
          codes,
        },
      });
      return { ...quote, branchId, classId, vehicleId, customerId, quotedAt: deps.clock.now() };
    });
  }
}
