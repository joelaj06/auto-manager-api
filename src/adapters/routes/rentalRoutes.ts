import { z } from "zod";
import type { RentalAvailability } from "../../application/use-cases/rentals/RentalAvailability.js";
import type { RentalQuotes } from "../../application/use-cases/rentals/RentalQuotes.js";
import type { RentalRateAdministration } from "../../application/use-cases/rentals/RentalRateAdministration.js";
import { PHOTO_VIEWS } from "../../domain/rentals/RentalInspection.js";
import { EXTRA_CATEGORIES, EXTRA_CHARGES } from "../../domain/rentals/RentalRates.js";
import { MANUAL_BLOCK_REASONS } from "../../domain/rentals/VehicleBlock.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const date = z.iso.date();
const idParams = z.object({ id: uuid });
const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const amount = z.string().regex(/^\d{1,13}(\.\d{1,4})?$/, 'Send amounts as text, e.g. "250.00"');
const percent = z.string().regex(/^-?\d{1,3}(\.\d{1,2})?$/, 'Send percents as text, e.g. "12.5"');
const code = z.string().trim().min(1).max(20);
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const taxCode = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,19}$/)
  .nullable()
  .optional();
const includeInactive = z.object({
  includeInactive: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default(false),
});

const classBody = z.object({
  code,
  name: z.string().trim().min(1).max(80),
  description: text(500),
  minDriverAge: z.number().int().min(16).max(99).nullable().optional(),
  minLicenceYears: z.number().int().min(0).max(60).nullable().optional(),
  turnaroundMinutes: z.number().int().min(0).max(1440).optional(),
  refuelPerQuarter: amount.nullable().optional(),
  sort: z.number().int().min(0).max(1_000_000).optional(),
  active: z.boolean().optional(),
});

const planBody = z.object({
  code,
  name: z.string().trim().min(1).max(120),
  classId: uuid.nullable().optional(),
  vehicleId: uuid.nullable().optional(),
  branchId: uuid.nullable().optional(),
  customerId: uuid.nullable().optional(),
  hourlyRate: amount.nullable().optional(),
  dailyRate: amount,
  weekendRate: amount.nullable().optional(),
  weeklyRate: amount.nullable().optional(),
  monthlyRate: amount.nullable().optional(),
  minHours: z.number().int().min(1).max(23).optional(),
  includedKmPerDay: z.number().int().min(1).max(10_000).nullable().optional(),
  extraKmRate: amount.nullable().optional(),
  chauffeurDaily: amount.nullable().optional(),
  chauffeurOvernight: amount.nullable().optional(),
  chauffeurOutOfTown: amount.nullable().optional(),
  taxCode,
  validFrom: date.nullable().optional(),
  validTo: date.nullable().optional(),
  seasons: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        startsOn: date,
        endsOn: date,
        adjustmentPercent: percent,
      }),
    )
    .max(50)
    .optional(),
  active: z.boolean().optional(),
  notes: text(2_000),
});

const extraBody = z.object({
  code,
  name: z.string().trim().min(1).max(80),
  description: text(500),
  category: z.enum(EXTRA_CATEGORIES),
  charge: z.enum(EXTRA_CHARGES),
  price: amount,
  maxCharge: amount.nullable().optional(),
  maxQuantity: z.number().int().min(1).max(20).optional(),
  taxCode,
  classIds: z.array(uuid).max(100).optional(),
  sort: z.number().int().min(0).max(1_000_000).optional(),
  active: z.boolean().optional(),
});

const zoneBody = z.object({
  name: z.string().trim().min(1).max(80),
  deliveryFee: amount.optional(),
  collectionFee: amount.optional(),
  outOfTownDaily: amount.optional(),
  active: z.boolean().optional(),
});

const promoBody = z.object({
  code,
  description: text(500),
  discountPercent: percent.nullable().optional(),
  discount: amount.nullable().optional(),
  validFrom: date.nullable().optional(),
  validTo: date.nullable().optional(),
  minDays: z.number().int().min(1).max(365).nullable().optional(),
  maxUses: z.number().int().min(1).nullable().optional(),
  classIds: z.array(uuid).max(100).optional(),
  active: z.boolean().optional(),
});

export const quoteBody = z.object({
  pickupAt: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
  returnAt: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
  classId: uuid.nullable().optional(),
  vehicleId: uuid.nullable().optional(),
  branchId: uuid.nullable().optional(),
  customerId: uuid.nullable().optional(),
  ratePlanId: uuid.nullable().optional(),
  extras: z
    .array(z.object({ extraId: uuid, quantity: z.number().int().min(1).max(20).default(1) }))
    .max(30)
    .optional(),
  chauffeur: z
    .object({
      overnights: z.number().int().min(0).max(366).optional(),
      outOfTownDays: z.number().int().min(0).max(366).optional(),
    })
    .nullable()
    .optional(),
  deliveryZoneId: uuid.nullable().optional(),
  collectionZoneId: uuid.nullable().optional(),
  destinationZoneId: uuid.nullable().optional(),
  estimatedKm: z.number().int().min(0).max(1_000_000).nullable().optional(),
  promoCode: z.string().trim().min(3).max(20).nullable().optional(),
  discountPercent: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,2})?$/)
    .nullable()
    .optional(),
  override: z
    .object({ amount, reason: z.string().trim().min(3).max(300) })
    .nullable()
    .optional(),
});

const availabilityQuery = z.object({
  from: instant,
  to: instant,
  branchId: uuid.optional(),
  classId: uuid.optional(),
  customerId: uuid.optional(),
});

const calendarQuery = z.object({
  from: date,
  to: date,
  branchId: uuid.optional(),
  classId: uuid.optional(),
});

const holdBody = z.object({
  classId: uuid.nullable().optional(),
  vehicleId: uuid.nullable().optional(),
  branchId: uuid.nullable().optional(),
  pickupAt: instant,
  returnAt: instant,
  holdMinutes: z.number().int().min(5).max(10_080).optional(),
  customerId: uuid.nullable().optional(),
  note: text(500),
});

const blockBody = z.object({
  vehicleId: uuid,
  reason: z.enum(MANUAL_BLOCK_REASONS),
  startsAt: instant,
  endsAt: instant.nullable(),
  note: text(500),
  displace: z.boolean().optional(),
});

const blockChangeBody = z
  .object({ startsAt: instant, endsAt: instant.nullable(), note: text(500) })
  .partial();

export type RentalRouteDependencies = Readonly<{
  administration: RentalRateAdministration;
  quotes: RentalQuotes;
  availability: RentalAvailability;
}>;

/**
 * Rental pricing (docs/07 §4, §12): vehicle classes and class membership, rate plans with their
 * seasons, extras, delivery and out-of-town zones, promo codes, public holidays, the rental
 * pricing settings, and price quotes.
 */
export function rentalRoutes(deps: RentalRouteDependencies): ApiRoute[] {
  const { administration, quotes, availability } = deps;
  const manage = access.permission("rentals.rate_plans.manage");

  return [
    // --- classes ---
    defineRoute({
      method: "get",
      path: "/api/v1/vehicle-classes",
      summary: "Vehicle classes customers book, with how many vehicles each has",
      tags: ["rentals"],
      access: access.permission("rentals.view"),
      request: { query: includeInactive },
      responses: { 200: { description: "Classes" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await administration.classes(query.includeInactive)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/vehicle-classes",
      summary: "Add a vehicle class",
      tags: ["rentals"],
      access: manage,
      request: { body: classBody },
      responses: { 201: { description: "Class" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await administration.createClass(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/vehicle-classes/:id",
      summary: "Change or deactivate a vehicle class",
      tags: ["rentals"],
      access: manage,
      request: { params: idParams, body: classBody.partial() },
      responses: { 200: { description: "Class" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await administration.updateClass(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/vehicles/:id/rental-class",
      summary: "Put a vehicle in a rental class (null takes it out)",
      tags: ["rentals"],
      access: access.permission("vehicles.update"),
      request: { params: idParams, body: z.object({ classId: uuid.nullable() }) },
      responses: { 200: { description: "The vehicle's class" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(
            await administration.assignVehicleClass(principalOf(res), params.id, body.classId),
          ),
        );
      },
    }),

    // --- rate plans ---
    defineRoute({
      method: "get",
      path: "/api/v1/rental-rate-plans",
      summary: "Rate plans, by class, vehicle or customer",
      tags: ["rentals"],
      access: access.permission("rentals.view"),
      request: {
        query: includeInactive.extend({
          classId: uuid.optional(),
          vehicleId: uuid.optional(),
          customerId: uuid.optional(),
        }),
      },
      responses: { 200: { description: "Rate plans" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await administration.plans(query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/rental-rate-plans/:id",
      summary: "A rate plan with its seasons",
      tags: ["rentals"],
      access: access.permission("rentals.view"),
      request: { params: idParams },
      responses: { 200: { description: "Rate plan" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await administration.plan(params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/rental-rate-plans",
      summary: "Add a rate plan for a class or a vehicle (optionally a branch or a customer)",
      tags: ["rentals"],
      access: manage,
      request: { body: planBody },
      responses: { 201: { description: "Rate plan" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await administration.createPlan(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/rental-rate-plans/:id",
      summary: "Change a rate plan (seasons, when sent, replace the plan's seasons)",
      tags: ["rentals"],
      access: manage,
      request: { params: idParams, body: planBody.partial() },
      responses: { 200: { description: "Rate plan" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await administration.updatePlan(principalOf(res), params.id, body)));
      },
    }),

    // --- extras ---
    defineRoute({
      method: "get",
      path: "/api/v1/rental-extras",
      summary: "Extras offered with rentals (child seat, GPS, insurance …)",
      tags: ["rentals"],
      access: access.permission("rentals.view"),
      request: { query: includeInactive },
      responses: { 200: { description: "Extras" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await administration.extras(query.includeInactive)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/rental-extras",
      summary: "Add an extra",
      tags: ["rentals"],
      access: manage,
      request: { body: extraBody },
      responses: { 201: { description: "Extra" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await administration.createExtra(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/rental-extras/:id",
      summary: "Change or deactivate an extra",
      tags: ["rentals"],
      access: manage,
      request: { params: idParams, body: extraBody.partial() },
      responses: { 200: { description: "Extra" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await administration.updateExtra(principalOf(res), params.id, body)));
      },
    }),

    // --- zones ---
    defineRoute({
      method: "get",
      path: "/api/v1/rental-zones",
      summary: "Delivery, collection and out-of-town zones",
      tags: ["rentals"],
      access: access.permission("rentals.view"),
      request: { query: includeInactive },
      responses: { 200: { description: "Zones" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await administration.zones(query.includeInactive)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/rental-zones",
      summary: "Add a zone",
      tags: ["rentals"],
      access: manage,
      request: { body: zoneBody },
      responses: { 201: { description: "Zone" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await administration.createZone(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/rental-zones/:id",
      summary: "Change or deactivate a zone",
      tags: ["rentals"],
      access: manage,
      request: { params: idParams, body: zoneBody.partial() },
      responses: { 200: { description: "Zone" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await administration.updateZone(principalOf(res), params.id, body)));
      },
    }),

    // --- promo codes ---
    defineRoute({
      method: "get",
      path: "/api/v1/rental-promo-codes",
      summary: "Promo codes, newest first, with their uses",
      tags: ["rentals"],
      access: manage,
      responses: { 200: { description: "Promo codes" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await administration.promos()));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/rental-promo-codes",
      summary: "Add a promo code (a percent or an amount off the rental charge)",
      tags: ["rentals"],
      access: manage,
      request: { body: promoBody },
      responses: { 201: { description: "Promo code" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await administration.createPromo(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/rental-promo-codes/:id",
      summary: "Change or deactivate a promo code",
      tags: ["rentals"],
      access: manage,
      request: { params: idParams, body: promoBody.partial() },
      responses: { 200: { description: "Promo code" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await administration.updatePromo(principalOf(res), params.id, body)));
      },
    }),

    // --- holidays and settings ---
    defineRoute({
      method: "get",
      path: "/api/v1/public-holidays",
      summary: "The business's public holidays of a year",
      tags: ["rentals"],
      access: access.permission("rentals.view"),
      request: {
        query: z.object({ year: z.coerce.number().int().min(2000).max(2100) }),
      },
      responses: { 200: { description: "Holidays" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await administration.holidays(query.year)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/public-holidays",
      summary: "Add a public holiday",
      tags: ["rentals"],
      access: manage,
      request: { body: z.object({ date, name: z.string().trim().min(1).max(80) }) },
      responses: { 201: { description: "Holiday" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await administration.addHoliday(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/public-holidays/:id",
      summary: "Remove a holiday entered by mistake",
      tags: ["rentals"],
      access: manage,
      request: { params: idParams },
      responses: { 204: { description: "Removed" } },
      handler: async ({ params }, _req, res) => {
        await administration.removeHoliday(principalOf(res), params.id);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/settings/rentals",
      summary: "Rental pricing settings (weekend days, grace, tier thresholds, discount limit)",
      tags: ["settings"],
      access: access.permission("settings.view"),
      responses: { 200: { description: "Settings" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await administration.settings()));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/settings/rentals",
      summary: "Change the rental pricing settings",
      tags: ["settings"],
      access: manage,
      request: {
        body: z.object({
          weekendDays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
          holidaysAsWeekend: z.boolean().optional(),
          graceMinutes: z.number().int().min(0).max(240).optional(),
          weeklyFromDays: z.number().int().min(2).max(7).optional(),
          monthlyFromDays: z.number().int().min(8).max(30).optional(),
          reservationHours: z.number().int().min(1).max(168).optional(),
          freeCancellationHours: z.number().int().min(0).max(720).optional(),
          lateCancellationFeePercent: percent.optional(),
          noShowFeePercent: percent.optional(),
          inspectionItems: z
            .array(z.object({ key: z.string().max(40), label: z.string().trim().min(1).max(80) }))
            .max(30)
            .optional(),
          inspectionPhotoViews: z.array(z.enum(PHOTO_VIEWS)).max(6).optional(),
          cleaningFee: amount.optional(),
          maxDiscountPercent: z
            .string()
            .regex(/^\d{1,3}(\.\d{1,2})?$/)
            .optional(),
        }),
      },
      responses: { 200: { description: "Settings" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await administration.updateSettings(principalOf(res), body)));
      },
    }),

    // --- quotes ---
    defineRoute({
      method: "post",
      path: "/api/v1/rentals/quotes",
      summary: "Price a rental: lines, discounts, tax and totals (nothing is stored)",
      tags: ["rentals"],
      access: access.permission("rentals.view"),
      request: { body: quoteBody },
      responses: { 200: { description: "Quote" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await quotes.quote(principalOf(res), body)));
      },
    }),

    // --- availability (docs/07 §3) ---
    defineRoute({
      method: "get",
      path: "/api/v1/rentals/availability",
      summary: "Classes with free vehicles at a branch for the times, with their prices",
      tags: ["rentals"],
      access: access.permission("rentals.view"),
      request: { query: availabilityQuery },
      responses: { 200: { description: "Classes" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await availability.search(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/rentals/calendar",
      summary: "Vehicles with their bookings and blocks, and free vehicles per class per day",
      tags: ["rentals"],
      access: access.permission("rentals.view"),
      request: { query: calendarQuery },
      responses: { 200: { description: "Calendar" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await availability.calendar(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/rentals/holds",
      summary: "Hold a vehicle, or the best-fit vehicle of a class, until the hold lapses",
      tags: ["rentals"],
      access: access.permission("rentals.create"),
      request: { body: holdBody },
      responses: { 201: { description: "Block" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await availability.hold(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/vehicle-blocks",
      summary: "Take a vehicle out of rental (maintenance, transfer, sale hold …)",
      tags: ["rentals"],
      access: access.permission("vehicles.update"),
      request: { body: blockBody },
      responses: { 201: { description: "Block and the class bookings moved" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await availability.block(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/vehicle-blocks/:id",
      summary: "A block of a vehicle",
      tags: ["rentals"],
      access: access.permission("rentals.view"),
      request: { params: idParams },
      responses: { 200: { description: "Block" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await availability.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/vehicle-blocks/:id",
      summary: "Change a block's times or note",
      tags: ["rentals"],
      access: access.signedIn(),
      request: { params: idParams, body: blockChangeBody },
      responses: { 200: { description: "Block" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await availability.reschedule(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/vehicle-blocks/:id/release",
      summary: "Free the vehicle (a hold given up, maintenance done …)",
      tags: ["rentals"],
      access: access.signedIn(),
      request: {
        params: idParams,
        body: z.object({ reason: z.string().trim().min(3).max(300) }),
      },
      responses: { 200: { description: "Block" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await availability.release(principalOf(res), params.id, body.reason)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/vehicle-blocks/:id/move",
      summary: "Move a class booking to another vehicle of the class (the best fit by default)",
      tags: ["rentals"],
      access: access.permission("rentals.create"),
      request: { params: idParams, body: z.object({ vehicleId: uuid.nullable().optional() }) },
      responses: { 200: { description: "Block" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(await availability.move(principalOf(res), params.id, body.vehicleId ?? null)),
        );
      },
    }),
  ];
}
