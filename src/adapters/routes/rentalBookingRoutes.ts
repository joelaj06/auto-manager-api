import { z } from "zod";
import type { RentalBookings } from "../../application/use-cases/rentals/RentalBookings.js";
import type { RentalInspections } from "../../application/use-cases/rentals/RentalInspections.js";
import { FUEL_LEVELS } from "../../domain/assignments/VehicleAssignment.js";
import { FILE_KINDS } from "../../domain/files/FileKinds.js";
import { BOOKING_STATUSES } from "../../domain/rentals/RentalBooking.js";
import { PHOTO_VIEWS } from "../../domain/rentals/RentalInspection.js";
import { DAMAGE_AREAS, DAMAGE_SEVERITIES } from "../../domain/rentals/VehicleDamage.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { quoteBody } from "./rentalRoutes.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const idParams = z.object({ id: uuid });
const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));
const notes = z.string().trim().max(2000).nullable().optional();
const odometer = z.number().int().min(0).max(10_000_000);
const amount = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/, 'Send amounts as text, e.g. "250.00"');
const photoParams = z.object({ id: uuid, fileId: uuid });

const photoUpload = z.object({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().max(100),
  sizeBytes: z.number().int().min(1).max(FILE_KINDS.rental_photo.maxBytes),
});

/** The inspection recorded with a check-out or check-in (docs/07 §6). */
const inspection = {
  checklist: z
    .array(
      z.object({
        key: z.string().max(40),
        ok: z.boolean(),
        note: z.string().max(300).nullable().optional(),
      }),
    )
    .max(30)
    .optional(),
  photos: z
    .array(z.object({ fileId: uuid, view: z.enum(PHOTO_VIEWS) }))
    .max(30)
    .optional(),
};
const damage = z.object({
  area: z.enum(DAMAGE_AREAS),
  severity: z.enum(DAMAGE_SEVERITIES),
  description: z.string().trim().min(3).max(1000),
  photoIds: z.array(uuid).max(10).optional(),
});

const createBody = quoteBody.extend({
  customerId: uuid,
  holdId: uuid.nullable().optional(),
  confirm: z.boolean().optional(),
  driverId: uuid.nullable().optional(),
  notes,
});

const changeBody = quoteBody
  .omit({ branchId: true, customerId: true })
  .partial()
  .extend({ driverId: uuid.nullable().optional(), notes });

const listQuery = z.object({
  status: z.enum([...BOOKING_STATUSES, "expired"]).optional(),
  branchId: uuid.optional(),
  customerId: uuid.optional(),
  vehicleId: uuid.optional(),
  from: instant.optional(),
  to: instant.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const callOffBody = z.object({
  reason: z.string().trim().min(3).max(300),
  waiveFee: z.boolean().optional(),
});

export type RentalBookingRouteDependencies = Readonly<{
  bookings: RentalBookings;
  inspections: RentalInspections;
}>;

/** Rental bookings (docs/07 §2, §12): reserve, confirm, check out, extend, check in, close. */
export function rentalBookingRoutes(deps: RentalBookingRouteDependencies): ApiRoute[] {
  const { bookings, inspections } = deps;
  const step = (
    path: string,
    summary: string,
    permission: Parameters<typeof access.permission>[0],
    body: z.ZodType,
    run: (actor: ReturnType<typeof principalOf>, id: string, body: never) => Promise<unknown>,
  ) =>
    defineRoute({
      method: "post",
      path: `/api/v1/rentals/:id/${path}`,
      summary,
      tags: ["rentals"],
      access: access.permission(permission),
      request: { params: idParams, body },
      responses: { 200: { description: "Booking" } },
      handler: async ({ params, body: input }, _req, res) => {
        res.json(envelope(await run(principalOf(res), params.id, input as never)));
      },
    });

  return [
    defineRoute({
      method: "get",
      path: "/api/v1/rentals",
      summary: "Rental bookings in the caller's branches, latest pickup first",
      tags: ["rentals"],
      access: access.permission("rentals.view"),
      request: { query: listQuery },
      responses: { 200: { description: "Bookings" } },
      handler: async ({ query }, _req, res) => {
        const page = await bookings.list(principalOf(res), query);
        res.json(envelope(page.items, { nextCursor: page.nextCursor }));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/rentals",
      summary: "Reserve (or book, confirmed) a class or a vehicle for a customer",
      tags: ["rentals"],
      access: access.permission("rentals.create"),
      request: { body: createBody },
      responses: { 201: { description: "Booking" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await bookings.create(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/rentals/:id",
      summary: "A booking with its charges and events",
      tags: ["rentals"],
      access: access.permission("rentals.view"),
      request: { params: idParams },
      responses: { 200: { description: "Booking" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await bookings.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/rentals/:id",
      summary: "Change a booking before check-out (re-quoted and re-checked)",
      tags: ["rentals"],
      access: access.permission("rentals.update"),
      request: { params: idParams, body: changeBody },
      responses: { 200: { description: "Booking" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await bookings.change(principalOf(res), params.id, body)));
      },
    }),
    step("confirm", "Confirm a reservation", "rentals.update", z.object({}), (actor, id) =>
      bookings.confirm(actor, id),
    ),
    step(
      "vehicle",
      "Give a class booking another vehicle of the class (the best fit by default)",
      "rentals.create",
      z.object({ vehicleId: uuid.nullable().optional() }),
      (actor, id, body: { vehicleId?: string | null }) =>
        bookings.changeVehicle(actor, id, body.vehicleId ?? null),
    ),
    step(
      "checkout",
      "Hand the vehicle over: ID and licence seen, odometer, fuel, checklist, photos, damages found",
      "rentals.checkout",
      z.object({
        vehicleId: uuid.nullable().optional(),
        driverId: uuid.nullable().optional(),
        waiveDeposit: z.boolean().optional(),
        odometer,
        fuel: z.enum(FUEL_LEVELS),
        idChecked: z.boolean(),
        ...inspection,
        damages: z.array(damage).max(20).optional(),
        notes,
      }),
      (actor, id, body) => bookings.checkOut(actor, id, body),
    ),
    step(
      "extend",
      "Move the return later (re-checked and charged at the booked rates)",
      "rentals.update",
      z.object({ returnAt: instant }),
      (actor, id, body: { returnAt: Date }) => bookings.extend(actor, id, body.returnAt),
    ),
    step(
      "checkin",
      "Take the vehicle back: inspection and new damages; late return, mileage, refuelling, cleaning and damage are charged",
      "rentals.checkin",
      z.object({
        odometer,
        fuel: z.enum(FUEL_LEVELS),
        returnedAt: instant.optional(),
        needsMaintenance: z.boolean().optional(),
        needsCleaning: z.boolean().optional(),
        waiveRefuel: z.boolean().optional(),
        ...inspection,
        damages: z
          .array(
            damage.extend({
              estimate: amount.nullable().optional(),
              chargeCustomer: z.boolean().optional(),
            }),
          )
          .max(20)
          .optional(),
        notes,
      }),
      (actor, id, body) => bookings.checkIn(actor, id, body),
    ),
    defineRoute({
      method: "get",
      path: "/api/v1/rentals/:id/inspections",
      summary:
        "Check-out and check-in inspections, what changed, the damages found and the vehicle's damage map",
      tags: ["rentals"],
      access: access.permission("rentals.view"),
      request: { params: idParams },
      responses: { 200: { description: "Inspections" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await inspections.view(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/rentals/:id/photos",
      summary: "Upload a photo for the next check-out or check-in (then confirm it)",
      tags: ["rentals"],
      access: access.permission("rentals.view"),
      request: { params: idParams, body: photoUpload },
      responses: { 201: { description: "Upload URL" } },
      handler: async ({ params, body }, _req, res) => {
        res
          .status(201)
          .json(envelope(await inspections.startPhoto(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/rentals/:id/photos/:fileId/complete",
      summary: "Confirm a rental photo upload",
      tags: ["rentals"],
      access: access.permission("rentals.view"),
      request: { params: photoParams },
      responses: { 200: { description: "Photo" } },
      handler: async ({ params }, _req, res) => {
        res.json(
          envelope(await inspections.completePhoto(principalOf(res), params.id, params.fileId)),
        );
      },
    }),
    step("close", "Close a returned booking", "rentals.update", z.object({}), (actor, id) =>
      bookings.close(actor, id),
    ),
    step(
      "cancel",
      "Cancel a booking before check-out (late cancellations pay the policy fee)",
      "rentals.cancel",
      callOffBody,
      (actor, id, body) => bookings.cancel(actor, id, body),
    ),
    step(
      "no-show",
      "The customer did not come (from the pickup time; the no-show fee applies)",
      "rentals.cancel",
      callOffBody,
      (actor, id, body) => bookings.noShow(actor, id, body),
    ),
  ];
}
