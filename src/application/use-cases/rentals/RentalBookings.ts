import type { FuelLevel } from "../../../domain/assignments/VehicleAssignment.js";
import { Money } from "../../../domain/money/Money.js";
import {
  cancellationFee,
  isMileage,
  quoteAmount,
  quoteDelta,
  RentalBooking,
  RentalBookingError,
  type BookingStatus,
  type ChargeAmount,
  type ChargeKind,
  type QuoteJson,
  type ShownStatus,
} from "../../../domain/rentals/RentalBooking.js";
import type { PricingTerms, RentalQuote } from "../../../domain/rentals/RentalPricing.js";
import type { VehicleBlock } from "../../../domain/rentals/VehicleBlock.js";
import type { AuthorizationPolicy } from "../../authorization/AuthorizationPolicy.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import { PermissionDeniedError } from "../../errors/AuthErrors.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import { VehicleUnavailableError } from "../../errors/RentalErrors.js";
import type { Page } from "../../dto/Page.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type {
  BookingEvent,
  BookingEventType,
  IRentalBookings,
  Renter,
} from "../../ports/IRentalBookings.js";
import type { IRentalRates } from "../../ports/IRentalRates.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { FleetVehicle, IVehicleBlocks } from "../../ports/IVehicleBlocks.js";
import { PageCursor } from "../../services/PageCursor.js";
import { localDateTime } from "../../services/TenantLocalTime.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { DocumentNumbering } from "../reference/DocumentNumbering.js";
import type { OdometerLog } from "../vehicles/OdometerLog.js";
import type { VehicleAccess } from "../vehicles/VehicleAccess.js";
import type { VehicleRegistry } from "../vehicles/VehicleRegistry.js";
import type { RentalAccounts } from "./RentalAccounts.js";
import type { RentalAgreements, RentalDocument } from "./RentalAgreements.js";
import type { RentalNotifications } from "./RentalNotifications.js";
import type { RentalAvailability } from "./RentalAvailability.js";
import type { InspectionInput, RentalInspections } from "./RentalInspections.js";
import { RentalRateNotFoundError } from "./RentalRateAdministration.js";
import type { QuoteRequest, RentalQuotes } from "./RentalQuotes.js";

export class RentalBookingNotFoundError extends ApplicationError {
  readonly code = "RENTAL_BOOKING_NOT_FOUND";
  constructor() {
    super("Booking not found");
  }
}

const HOUR = 3_600_000;
const YEAR_MS = 365.25 * 24 * HOUR;
const REF_TYPE = "rental_booking";

export type BookingRequest = QuoteRequest &
  Readonly<{
    customerId: string;
    /** Turn this hold (P5-2) into the booking. */
    holdId?: string | null;
    /** Confirm at once (rentals.update): a walk-in, a prepaid or a corporate booking. */
    confirm?: boolean;
    /** For a corporate customer: the authorised driver. */
    driverId?: string | null;
    notes?: string | null;
  }>;

export type BookingChange = Partial<
  Omit<BookingRequest, "customerId" | "holdId" | "confirm" | "branchId">
>;

export type CheckOutRequest = Omit<InspectionInput, "needsCleaning" | "waiveRefuel"> &
  Readonly<{
    /** Another vehicle of the class booked (a class booking only). */
    vehicleId?: string | null;
    /** A company's authorised driver, when not named yet. */
    driverId?: string | null;
    /** Out without the class's deposit (rentals.price.override). */
    waiveDeposit?: boolean;
    odometer: number;
    fuel: FuelLevel;
    notes?: string | null;
  }>;

export type CheckInRequest = Omit<InspectionInput, "idChecked"> &
  Readonly<{
    odometer: number;
    fuel: FuelLevel;
    /** When the vehicle came back (default now). */
    returnedAt?: Date;
    /** The vehicle goes to maintenance instead of back to rent (so does a major damage). */
    needsMaintenance?: boolean;
    notes?: string | null;
  }>;

export type BookingQuery = Readonly<{
  status?: ShownStatus;
  branchId?: string;
  customerId?: string;
  vehicleId?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}>;

export type ChargeView = Readonly<{
  id: string;
  kind: ChargeKind;
  description: string;
  net: Money;
  tax: Money;
  total: Money;
  createdAt: Date;
}>;

export type BookingView = Readonly<{
  id: string;
  number: string;
  status: ShownStatus;
  branchId: string;
  customer: Readonly<{ id: string; name: string }>;
  driver: Readonly<{ id: string; name: string }> | null;
  classId: string | null;
  byClass: boolean;
  vehicle: Pick<FleetVehicle, "id" | "code" | "plateNumber" | "make" | "model">;
  blockId: string;
  pickupAt: Date;
  returnAt: Date;
  expiresAt: Date | null;
  currency: string;
  quote: QuoteJson;
  confirmedAt: Date | null;
  checkOut: Readonly<{ at: Date; odometer: number; fuel: FuelLevel | null }> | null;
  return: Readonly<{ at: Date; odometer: number; fuel: FuelLevel | null; km: number }> | null;
  closedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  notes: string | null;
  charges: readonly ChargeView[];
  /** What the booking charges in all (payments come with invoicing, P5-5). */
  charged: Money;
  createdAt: Date;
}>;

export type BookingDetail = BookingView &
  Readonly<{
    events: readonly BookingEvent[];
    /** The rental agreement and the return note, newest first, with their signers (P5-6). */
    documents: readonly RentalDocument[];
    warnings: readonly string[];
  }>;

type Deps = Readonly<{
  unitOfWork: IUnitOfWork;
  bookings: IRentalBookings;
  blocks: IVehicleBlocks;
  rates: IRentalRates;
  availability: RentalAvailability;
  quotes: RentalQuotes;
  inspections: RentalInspections;
  accounts: RentalAccounts;
  agreements: RentalAgreements;
  /** The customer told of the confirmation (P5-7). */
  notifications?: RentalNotifications;
  vehicleAccess: VehicleAccess;
  registry: VehicleRegistry;
  odometer: OdometerLog;
  numbering: DocumentNumbering;
  organisation: IOrganisationSettings;
  policy: AuthorizationPolicy;
  auditTrail: IAuditTrail;
  requestContext: IRequestContext;
  ids: IIdGenerator;
  clock: { now(): Date };
}>;

/**
 * The rental booking lifecycle (docs/07 §2, §6, §7): reserve → confirm → check out → extend →
 * check in → close, or cancel / no-show. Each step keeps the vehicle block in step (P5-2), the
 * vehicle's status at hand-over and return, an event, and the charges it adds; the terms the
 * booking was priced with price its extensions, late return and mileage (decisions 332–341).
 */
export class RentalBookings {
  constructor(private readonly deps: Deps) {}

  // --- reading ---

  async get(actor: Principal, id: string): Promise<BookingDetail> {
    return this.deps.unitOfWork.run(async () => {
      const booking = await this.reach(actor, id, "rentals.view");
      return this.detail(booking, []);
    });
  }

  async list(actor: Principal, query: BookingQuery): Promise<Page<BookingView>> {
    const { deps } = this;
    const after = query.cursor === undefined ? undefined : PageCursor.parse(query.cursor, 2).values;
    return deps.unitOfWork.run(async () => {
      const now = deps.clock.now();
      const branchIds =
        query.branchId === undefined
          ? deps.vehicleAccess.branchesFor(actor, "rentals.view")
          : [(await deps.vehicleAccess.branch(actor, "rentals.view", query.branchId)).id];
      const shown = query.status;
      const statuses: readonly BookingStatus[] | undefined =
        shown === undefined ? undefined : shown === "expired" ? ["reserved"] : [shown];
      const rows = await deps.bookings.list({
        branchIds,
        ...(statuses === undefined ? {} : { statuses }),
        ...(shown === "expired" || shown === "reserved"
          ? { lapsedAt: { now, lapsed: shown === "expired" } }
          : {}),
        ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
        ...(query.vehicleId === undefined ? {} : { vehicleId: query.vehicleId }),
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to }),
        ...(after === undefined
          ? {}
          : { after: { pickupAt: String(after[0]), id: String(after[1]) } }),
        limit: query.limit + 1,
      });
      const page = PageCursor.paginate(rows, query.limit, (b) => [
        b.snapshot().pickupAt.toISOString(),
        b.id,
      ]);
      return {
        ...page,
        items: await Promise.all(page.items.map((b) => this.view(b))),
      };
    });
  }

  // --- reserving ---

  /** Reserves (or books, confirmed) a class or a vehicle for a customer at the quoted price. */
  create(actor: Principal, request: BookingRequest): Promise<BookingDetail> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const now = deps.clock.now();
      if (request.returnAt <= now) throw new RentalBookingError("The rental is over already");
      const confirm = request.confirm === true;
      const quoted = await deps.quotes.quoteWithTerms(actor, request);
      deps.policy.require(actor, "rentals.create", { branchId: quoted.branchId });
      if (confirm) deps.policy.require(actor, "rentals.update", { branchId: quoted.branchId });
      const { warnings, renter } = await this.renterRules(
        request.customerId,
        quoted.classId,
        request,
        request.driverId ?? null,
      );
      await deps.accounts.assertCredit(
        actor,
        renter,
        quoteAmount(quoted).totalMinor,
        quoted.branchId,
      );
      const settings = await deps.rates.settings();
      const id = deps.ids.next();
      const expiresAt = confirm ? null : new Date(now.getTime() + settings.reservationHours * HOUR);

      const held = given(request.holdId)
        ? await this.releaseHold(actor, request.holdId, quoted, now)
        : null;
      const block = await this.placePreferring(
        id,
        held ?? quoted.vehicleId,
        {
          classId: quoted.vehicleId === null ? quoted.classId : null,
          branchId: quoted.branchId,
          customerId: request.customerId,
        },
        request.pickupAt,
        request.returnAt,
        confirm ? "confirmed" : "hold",
        expiresAt,
        actor.userId,
      );

      const { terms, ...quote } = quoted;
      const booking = RentalBooking.reserve({
        id,
        number: await deps.numbering.next("rental", now),
        branchId: quoted.branchId,
        customerId: request.customerId,
        driverId: request.driverId ?? null,
        classId: quoted.classId,
        vehicleId: block.vehicleId,
        byClass: block.classId !== null,
        blockId: block.id,
        pickupAt: request.pickupAt,
        returnAt: request.returnAt,
        expiresAt,
        currency: quote.currency,
        terms,
        quote: toJson(quote),
        notes: request.notes ?? null,
        createdBy: actor.userId,
        createdAt: now,
        confirmed: confirm,
      });
      await deps.bookings.insert(booking);
      const event = await this.event(booking, "reserved", actor, {
        pickupAt: request.pickupAt.toISOString(),
        returnAt: request.returnAt.toISOString(),
        vehicleId: block.vehicleId,
        byClass: block.classId !== null,
        holdId: request.holdId ?? null,
      });
      await this.charge(
        booking,
        event,
        "rental",
        rentalDescription(quote),
        quoteAmount(quote),
        actor,
      );
      if (confirm) {
        await this.event(booking, "confirmed", actor, {});
        await deps.notifications?.confirmed(booking);
      }
      await this.audit(actor, "rental_booking.created", booking, null);
      return this.detail(booking, warnings);
    });
  }

  /** New times, extras, class or vehicle before check-out: re-quoted, re-checked, re-placed. */
  change(actor: Principal, id: string, change: BookingChange): Promise<BookingDetail> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const booking = await this.reach(actor, id, "rentals.update", true);
      const before = booking.snapshot();
      if (!booking.isUpcoming())
        throw new RentalBookingError("Only a booking not yet checked out is changed");
      const now = deps.clock.now();
      const switchesClass = change.classId !== undefined && change.vehicleId === undefined;
      const request: QuoteRequest = {
        ...this.requestOf(booking),
        ...(switchesClass ? { vehicleId: null } : {}),
        ...change,
        branchId: before.branchId,
        customerId: before.customerId,
      };
      if (request.returnAt <= now) throw new RentalBookingError("The rental is over already");
      const quoted = await deps.quotes.quoteWithTerms(actor, request);
      const driverId = change.driverId === undefined ? before.driverId : change.driverId;
      const { warnings, renter } = await this.renterRules(
        before.customerId,
        quoted.classId,
        request,
        driverId,
      );
      await deps.accounts.assertCredit(
        actor,
        renter,
        quoteAmount(quoted).totalMinor - jsonAmount(before.quote).totalMinor,
        before.branchId,
      );

      // Free the vehicle, then hold it again for the new terms (all or nothing).
      await deps.availability.free(before.blockId, "Booking changed", actor.userId);
      const keepVehicle =
        quoted.vehicleId === null && quoted.classId === before.classId ? before.vehicleId : null;
      const status = before.status === "reserved" && !booking.isLapsed(now) ? "hold" : "confirmed";
      const expiresAt =
        before.status === "reserved"
          ? booking.isLapsed(now)
            ? new Date(now.getTime() + (await deps.rates.settings()).reservationHours * HOUR)
            : before.expiresAt
          : null;
      const placed = await this.placePreferring(
        booking.id,
        keepVehicle ?? quoted.vehicleId,
        {
          classId: quoted.vehicleId === null ? quoted.classId : null,
          branchId: before.branchId,
          customerId: before.customerId,
        },
        request.pickupAt,
        request.returnAt,
        status,
        expiresAt,
        actor.userId,
      );

      const { terms, ...quote } = quoted;
      booking.change({
        pickupAt: request.pickupAt,
        returnAt: request.returnAt,
        terms,
        quote: toJson(quote),
        placement: { vehicleId: placed.vehicleId, blockId: placed.id },
        expiresAt,
        ...(change.notes === undefined ? {} : { notes: change.notes }),
        now,
      });
      if (driverId !== before.driverId) booking.nameDriver(driverId, now);
      await deps.bookings.update(booking);
      const delta = minus(quoteAmount(quote), jsonAmount(before.quote));
      const event = await this.event(booking, "changed", actor, {
        from: { pickupAt: before.pickupAt, returnAt: before.returnAt, vehicleId: before.vehicleId },
        to: { pickupAt: request.pickupAt, returnAt: request.returnAt, vehicleId: placed.vehicleId },
        totalMinor: delta.totalMinor,
      });
      if (delta.totalMinor !== 0 || delta.netMinor !== 0)
        await this.charge(booking, event, "change", "Booking changed: new price", delta, actor);
      await this.audit(actor, "rental_booking.changed", booking, before);
      return this.detail(booking, warnings);
    });
  }

  /** The prepayment or approval is in: the hold becomes firm. */
  confirm(actor: Principal, id: string): Promise<BookingDetail> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const booking = await this.reach(actor, id, "rentals.update", true);
      const before = booking.snapshot();
      const now = deps.clock.now();
      const renter = await deps.bookings.renter(before.customerId);
      if (renter !== null) riskRules(renter);
      if (booking.isLapsed(now)) {
        // The vehicle may have gone: hold it again (the same vehicle when it is still free).
        await deps.availability.free(before.blockId, "Reservation lapsed", actor.userId);
        const placed = await this.replace(booking, "confirmed", null, actor);
        booking.changeVehicle({ vehicleId: placed.vehicleId, blockId: placed.id }, now);
      } else {
        await deps.availability.setStatus(before.blockId, "confirmed", null);
      }
      booking.confirm(now);
      await deps.bookings.update(booking);
      await this.event(booking, "confirmed", actor, {
        lapsed: booking.snapshot().blockId !== before.blockId,
      });
      await deps.notifications?.confirmed(booking);
      await this.audit(actor, "rental_booking.confirmed", booking, before);
      return this.detail(booking, []);
    });
  }

  /** Another vehicle of the class for a class booking (the best fit when none is named). */
  changeVehicle(actor: Principal, id: string, vehicleId: string | null): Promise<BookingDetail> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const booking = await this.reach(actor, id, "rentals.create", true);
      const before = booking.snapshot();
      if (!booking.isUpcoming() || !before.byClass)
        throw new RentalBookingError("Only a class booking not yet checked out changes vehicle");
      if (booking.isLapsed(deps.clock.now()))
        throw new RentalBookingError("The reservation has lapsed: confirm or change it first");
      const moved = await deps.availability.moveTo(before.blockId, vehicleId);
      booking.changeVehicle({ vehicleId: moved.vehicleId, blockId: moved.id }, deps.clock.now());
      await this.event(booking, "vehicle_changed", actor, {
        from: before.vehicleId,
        to: moved.vehicleId,
      });
      await this.audit(actor, "rental_booking.vehicle_changed", booking, before);
      return this.detail(booking, []);
    });
  }

  // --- the rental ---

  /** The keys handed over: odometer, fuel, the vehicle on rent (docs/07 §6). */
  checkOut(actor: Principal, id: string, request: CheckOutRequest): Promise<BookingDetail> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const booking = await this.reach(actor, id, "rentals.checkout", true);
      const before = booking.snapshot();
      const now = deps.clock.now();
      if (before.status !== "confirmed")
        throw new RentalBookingError(
          before.status === "reserved"
            ? "Confirm the reservation before the keys are handed over"
            : `A booking that is ${before.status.replaceAll("_", " ")} is not checked out`,
        );
      let vehicleId = before.vehicleId;
      if (given(request.vehicleId) && request.vehicleId !== before.vehicleId) {
        if (!before.byClass)
          throw new RentalBookingError(
            "The booking is for one vehicle: change the booking instead",
          );
        vehicleId = (await deps.availability.moveTo(before.blockId, request.vehicleId)).vehicleId;
      }
      const vehicle = await deps.vehicleAccess.reach(actor, vehicleId, "rentals.checkout", true);
      if (vehicle.status !== "available" && vehicle.status !== "reserved_rental")
        throw new RentalBookingError(
          `${vehicle.snapshot().code} is ${vehicle.status.replaceAll("_", " ")}: it cannot go out now`,
        );
      const warnings = await this.handOverRules(actor, booking, request);
      const { inspection, damages } = await deps.inspections.record(
        actor,
        booking,
        "check_out",
        { vehicleId, odometer: request.odometer, fuel: request.fuel, at: now },
        request,
        request.notes ?? null,
      );

      // Out early: the vehicle is busy from now.
      const block = (await deps.blocks.get(before.blockId))!;
      if (now < block.startsAt)
        await deps.availability.retime(block.id, now, block.endsAt ?? before.returnAt);
      await deps.availability.setStatus(block.id, "out", null);
      if (given(request.driverId) && request.driverId !== before.driverId)
        booking.nameDriver(request.driverId, now);
      booking.checkOut({ at: now, odometer: request.odometer, fuel: request.fuel, vehicleId, now });
      await deps.bookings.update(booking);
      await deps.odometer.recordFor(
        vehicle,
        { value: request.odometer, readAt: now, note: request.notes ?? null },
        "rental",
        booking.id,
        actor.userId,
      );
      await deps.registry.moveByModule(vehicle, "on_rent", {
        ref: { type: REF_TYPE, id: booking.id },
        reason: `Rental ${before.number}`,
        userId: actor.userId,
      });
      await this.event(booking, "checked_out", actor, {
        vehicleId,
        odometer: request.odometer,
        fuel: request.fuel,
        inspectionId: inspection.id,
        damagesFound: damages.map((d) => d.id),
        notes: request.notes ?? null,
      });
      // The agreement with the terms and the checklist as recorded, for both sides to sign.
      await deps.agreements.atCheckOut(actor, booking);
      await this.audit(actor, "rental_booking.checked_out", booking, before);
      return this.detail(booking, warnings);
    });
  }

  /**
   * A later return (docs/07 §7): the vehicle must be free until then (the next booking may be in
   * the way), and the extra time is charged at the booked rates.
   */
  extend(actor: Principal, id: string, returnAt: Date): Promise<BookingDetail> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const booking = await this.reach(actor, id, "rentals.update", true);
      const before = booking.snapshot();
      const block = (await deps.blocks.get(before.blockId))!;
      if (returnAt <= before.returnAt)
        throw new RentalBookingError("An extension moves the return later");
      await deps.availability.retime(block.id, block.startsAt, returnAt);
      // An agreed price covers the booked period: the extra time is the rates' difference.
      const atRates = (to: Date) =>
        deps.quotes.reprice(before.terms, before.pickupAt, to, { withoutOverride: true });
      const delta = quoteDelta(await atRates(before.returnAt), await atRates(returnAt));
      const quote = await deps.quotes.reprice(before.terms, before.pickupAt, returnAt);
      booking.extend({ returnAt, quote: toJson(quote), now: deps.clock.now() });
      await deps.bookings.update(booking);
      const event = await this.event(booking, "extended", actor, {
        from: before.returnAt.toISOString(),
        to: returnAt.toISOString(),
        totalMinor: delta.totalMinor,
      });
      await this.charge(
        booking,
        event,
        "extension",
        `Extension to ${this.local(returnAt, await this.timezone())}`,
        delta,
        actor,
      );
      await this.audit(actor, "rental_booking.extended", booking, before);
      return this.detail(booking, []);
    });
  }

  /**
   * The vehicle back (docs/07 §6): late return and the km driven charged at the booked rates,
   * the vehicle available again (or to maintenance), the block ending at the return.
   */
  checkIn(actor: Principal, id: string, request: CheckInRequest): Promise<BookingDetail> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const booking = await this.reach(actor, id, "rentals.checkin", true);
      const before = booking.snapshot();
      const now = deps.clock.now();
      const at = request.returnedAt ?? now;
      if (before.status !== "checked_out")
        throw new RentalBookingError("Only a checked-out booking is returned");
      const vehicle = await deps.vehicleAccess.reach(
        actor,
        before.vehicleId,
        "rentals.checkin",
        true,
      );

      // Early returns are not refunded; late ones are priced for the time kept (grace included).
      const billedTo = at > before.returnAt ? at : before.returnAt;
      const km = request.odometer - (before.odometerOut ?? 0);
      const atRates = (to: Date, estimatedKm?: number | null) =>
        deps.quotes.reprice(before.terms, before.pickupAt, to, {
          withoutOverride: true,
          ...(estimatedKm === undefined ? {} : { estimatedKm }),
        });
      const booked = await atRates(before.returnAt);
      const kept = await atRates(billedTo);
      const late = quoteDelta(booked, kept, (k) => !isMileage(k));
      const driven = km >= 0 ? await atRates(billedTo, km) : kept;
      const mileage = quoteDelta(kept, driven, isMileage);
      const quote = await deps.quotes.reprice(before.terms, before.pickupAt, billedTo, {
        estimatedKm: km >= 0 ? km : null,
      });
      booking.checkIn({
        at,
        odometer: request.odometer,
        fuel: request.fuel,
        quote: toJson(quote),
        now,
      });
      const inspected = await deps.inspections.record(
        actor,
        booking,
        "check_in",
        { vehicleId: before.vehicleId, odometer: request.odometer, fuel: request.fuel, at },
        request,
        request.notes ?? null,
      );
      const toMaintenance =
        request.needsMaintenance === true ||
        inspected.damages.some((d) => d.snapshot().severity === "major");

      // The block ends at the return (turnaround after it); a late vehicle may run into the next
      // booking, which then keeps its time and is named in the event.
      const block = (await deps.blocks.get(before.blockId))!;
      const { cappedBy } = await deps.availability.retime(block.id, block.startsAt, at, {
        capAtNext: true,
      });
      await deps.availability.setStatus(block.id, "confirmed", null);
      await deps.bookings.update(booking);
      await deps.odometer.recordFor(
        vehicle,
        { value: request.odometer, readAt: at, note: request.notes ?? null },
        "rental",
        booking.id,
        actor.userId,
      );
      if (vehicle.status === "on_rent")
        await deps.registry.moveByModule(vehicle, toMaintenance ? "in_maintenance" : "available", {
          ref: { type: REF_TYPE, id: booking.id },
          reason: `Back from rental ${before.number}`,
          userId: actor.userId,
        });
      const lateMinutes = Math.max(
        0,
        Math.round((at.getTime() - before.returnAt.getTime()) / 60_000),
      );
      const event = await this.event(booking, "returned", actor, {
        at: at.toISOString(),
        odometer: request.odometer,
        fuel: request.fuel,
        km,
        lateMinutes,
        nextBookingInTheWay: cappedBy?.refId ?? cappedBy?.id ?? null,
        inspectionId: inspected.inspection.id,
        damagesFound: inspected.damages.map((d) => d.id),
        toMaintenance,
        notes: request.notes ?? null,
      });
      if (!isZero(late))
        await this.charge(
          booking,
          event,
          "late_return",
          `Late return (${lateMinutes} minutes)`,
          late,
          actor,
        );
      if (!isZero(mileage))
        await this.charge(booking, event, "mileage", `Mileage: ${km} km driven`, mileage, actor);
      for (const c of inspected.charges)
        await this.charge(booking, event, c.kind, c.description, c.amount, actor, c.damageId);
      await deps.agreements.atCheckIn(actor, booking);
      await this.audit(actor, "rental_booking.returned", booking, before);
      return this.detail(
        booking,
        cappedBy === null ? [] : ["The vehicle came back after the next booking's pickup time"],
      );
    });
  }

  /** Done: invoiced; an agreement or return note still unsigned is a warning. */
  close(actor: Principal, id: string): Promise<BookingDetail> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const booking = await this.reach(actor, id, "rentals.update", true);
      const before = booking.snapshot();
      booking.close(deps.clock.now());
      await deps.bookings.update(booking);
      // What the rental cost is invoiced; payments for it are applied (decision 355).
      await deps.accounts.invoice(actor, booking);
      await this.event(booking, "closed", actor, {});
      await this.audit(actor, "rental_booking.closed", booking, before);
      return this.detail(booking, await deps.agreements.unsigned(booking.id));
    });
  }

  // --- not happening ---

  /** Cancelled before check-out; late cancellations pay the policy fee unless waived. */
  cancel(
    actor: Principal,
    id: string,
    request: Readonly<{ reason: string; waiveFee?: boolean }>,
  ): Promise<BookingDetail> {
    return this.callOff(actor, id, request, "cancellation");
  }

  /** The customer did not come: the vehicle is freed and the no-show fee charged unless waived. */
  noShow(
    actor: Principal,
    id: string,
    request: Readonly<{ reason: string; waiveFee?: boolean }>,
  ): Promise<BookingDetail> {
    return this.callOff(actor, id, request, "no_show");
  }

  private callOff(
    actor: Principal,
    id: string,
    request: Readonly<{ reason: string; waiveFee?: boolean }>,
    kind: "cancellation" | "no_show",
  ): Promise<BookingDetail> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const booking = await this.reach(actor, id, "rentals.cancel", true);
      const before = booking.snapshot();
      const now = deps.clock.now();
      const lapsed = booking.isLapsed(now);
      if (kind === "cancellation") booking.cancel(request.reason, now);
      else booking.noShow(request.reason, now);
      if (
        request.waiveFee === true &&
        !deps.policy.decide(actor, "rentals.price.override", { branchId: before.branchId }).allowed
      )
        throw new PermissionDeniedError("rentals.price.override");
      await deps.availability.free(
        before.blockId,
        kind === "cancellation" ? "Booking cancelled" : "Customer did not come",
        actor.userId,
      );
      await deps.bookings.update(booking);
      const charged = sum(await deps.bookings.charges(booking.id));
      const fee =
        request.waiveFee === true || lapsed
          ? { percent: "0", amountMinor: 0 }
          : cancellationFee(
              await deps.rates.settings(),
              {
                pickupAt: before.pickupAt,
                chargedMinor: charged.totalMinor,
                currency: before.currency,
              },
              now,
              kind,
            );
      const event = await this.event(
        booking,
        kind === "cancellation" ? "cancelled" : "no_show",
        actor,
        {
          reason: request.reason.trim(),
          feePercent: fee.percent,
          feeMinor: fee.amountMinor,
          waived: request.waiveFee === true,
        },
      );
      if (!isZero(charged))
        await this.charge(
          booking,
          event,
          "cancellation",
          kind === "cancellation" ? "Booking cancelled" : "Booking not used (no-show)",
          negate(charged),
          actor,
        );
      if (fee.amountMinor > 0)
        await this.charge(
          booking,
          event,
          kind === "cancellation" ? "cancellation_fee" : "no_show_fee",
          `${kind === "cancellation" ? "Late cancellation" : "No-show"} fee (${fee.percent}%)`,
          { netMinor: fee.amountMinor, taxMinor: 0, totalMinor: fee.amountMinor },
          actor,
        );
      await deps.accounts.invoice(actor, booking);
      await this.audit(
        actor,
        kind === "cancellation" ? "rental_booking.cancelled" : "rental_booking.no_show",
        booking,
        before,
      );
      return this.detail(booking, []);
    });
  }

  // --- helpers ---

  /** A hold (P5-2) the booking takes over: freed; its vehicle is returned to be tried first. */
  private async releaseHold(
    actor: Principal,
    holdId: string,
    quoted: Readonly<{ branchId: string; classId: string | null; vehicleId: string | null }>,
    now: Date,
  ): Promise<string> {
    const { deps } = this;
    const hold = await deps.blocks.get(holdId);
    if (
      hold === null ||
      hold.reason !== "rental" ||
      hold.refType !== null ||
      !deps.vehicleAccess.can(actor, "rentals.create", hold.branchId)
    )
      throw new RentalRateNotFoundError("Hold");
    if (hold.status !== "hold" || (hold.expiresAt !== null && hold.expiresAt <= now))
      throw new RentalBookingError("The hold has lapsed or was released");
    const matches =
      hold.branchId === quoted.branchId &&
      (quoted.vehicleId === null
        ? hold.classId === quoted.classId
        : hold.vehicleId === quoted.vehicleId);
    if (!matches) throw new RentalBookingError("The hold is for another vehicle, class or branch");
    await deps.availability.free(hold.id, "Taken over by a booking", actor.userId);
    return hold.vehicleId;
  }

  private placeFor(
    bookingId: string,
    target: Readonly<{
      vehicleId: string | null;
      classId: string | null;
      branchId: string;
      customerId: string;
    }>,
    startsAt: Date,
    endsAt: Date,
    status: "hold" | "confirmed",
    expiresAt: Date | null,
    actorId: string,
  ): Promise<VehicleBlock> {
    return this.deps.availability.place(
      {
        ...target,
        reason: "rental",
        status,
        startsAt,
        endsAt,
        expiresAt,
        refType: REF_TYPE,
        refId: bookingId,
      },
      actorId,
    );
  }

  /** Holds a vehicle again for the booking's own times (the same one when still free). */
  private replace(
    booking: RentalBooking,
    status: "hold" | "confirmed",
    expiresAt: Date | null,
    actor: Principal,
  ): Promise<VehicleBlock> {
    const b = booking.snapshot();
    return this.placePreferring(
      b.id,
      b.vehicleId,
      { classId: b.byClass ? b.classId : null, branchId: b.branchId, customerId: b.customerId },
      b.pickupAt,
      b.returnAt,
      status,
      expiresAt,
      actor.userId,
    );
  }

  /**
   * Places the booking on `vehicleId`; a class booking whose preferred vehicle is busy gets the
   * best-fit vehicle of the class instead.
   */
  private async placePreferring(
    bookingId: string,
    vehicleId: string | null,
    target: Readonly<{ classId: string | null; branchId: string; customerId: string }>,
    startsAt: Date,
    endsAt: Date,
    status: "hold" | "confirmed",
    expiresAt: Date | null,
    actorId: string,
  ): Promise<VehicleBlock> {
    const place = (vehicle: string | null) =>
      this.placeFor(
        bookingId,
        { ...target, vehicleId: vehicle },
        startsAt,
        endsAt,
        status,
        expiresAt,
        actorId,
      );
    if (vehicleId === null || target.classId === null) return place(vehicleId);
    try {
      return await place(vehicleId);
    } catch (error) {
      if (!(error instanceof VehicleUnavailableError)) throw error;
      return place(null);
    }
  }

  /** The quote request a booking's terms stand for (changes start from it). */
  private requestOf(booking: RentalBooking): QuoteRequest {
    const b = booking.snapshot();
    const t: PricingTerms = b.terms;
    return {
      pickupAt: b.pickupAt,
      returnAt: b.returnAt,
      classId: b.byClass ? b.classId : null,
      vehicleId: b.byClass ? null : b.vehicleId,
      extras: t.extras.map((e) => ({ extraId: e.extra.id, quantity: e.quantity })),
      chauffeur: t.chauffeur,
      deliveryZoneId: t.delivery?.id ?? null,
      collectionZoneId: t.collection?.id ?? null,
      destinationZoneId: t.destination?.id ?? null,
      estimatedKm: t.estimatedKm,
      promoCode: t.promo?.code ?? null,
      discountPercent: t.discountPercent,
      override:
        t.override === null
          ? null
          : {
              amount: Money.ofMinor(t.override.amountMinor, b.currency).toDecimalString(),
              reason: t.override.reason,
            },
    };
  }

  /**
   * Renter rules at booking (docs/07 §8, decisions 338, 358–359): a blacklisted customer or driver
   * is refused, one on watch is a warning; a company's rentals are driven by one of its
   * authorised drivers, whose age and licence are checked like an individual renter's.
   */
  private async renterRules(
    customerId: string,
    classId: string | null,
    request: Readonly<{ pickupAt: Date; returnAt: Date }>,
    driverId: string | null,
  ): Promise<{ warnings: string[]; renter: Renter }> {
    const { deps } = this;
    const renter = await deps.bookings.renter(customerId);
    if (renter === null) throw new RentalRateNotFoundError("Customer");
    const warnings = riskRules(renter);
    const driver = await this.driverOf(renter, driverId);
    if (driver === null) {
      warnings.push(
        `Name the driver (one of ${renter.name}'s authorised drivers) before the keys go out`,
      );
      return { warnings, renter };
    }
    if (driver !== renter) warnings.push(...riskRules(driver));
    const vehicleClass = classId === null ? null : await deps.rates.vehicleClass(classId);
    if (vehicleClass !== null && vehicleClass.minDriverAge !== null) {
      if (driver.dateOfBirth === null)
        warnings.push(
          `${driver.name}'s date of birth is not recorded (minimum age ${vehicleClass.minDriverAge})`,
        );
      else {
        const age = Math.floor(
          (request.pickupAt.getTime() - Date.parse(`${driver.dateOfBirth}T00:00:00Z`)) / YEAR_MS,
        );
        if (age < vehicleClass.minDriverAge)
          throw new RentalBookingError(
            `${vehicleClass.name} drivers are at least ${vehicleClass.minDriverAge}; ${driver.name} is ${age}`,
          );
      }
    }
    if (vehicleClass !== null && (vehicleClass.minLicenceYears ?? 0) > 0)
      warnings.push(
        `Check that ${driver.name} has held a licence for ${vehicleClass.minLicenceYears} years`,
      );
    return {
      warnings: [...warnings, ...(await this.licenceRules(driver, request.returnAt))],
      renter,
    };
  }

  /**
   * At the counter (docs/07 §6, decisions 343, 358–360): the renter and driver not blacklisted,
   * a company's driver named and authorised, the licence valid to the return, the class's
   * deposit held (unless on account or waived).
   */
  private async handOverRules(
    actor: Principal,
    booking: RentalBooking,
    request: CheckOutRequest,
  ): Promise<string[]> {
    const { deps } = this;
    const b = booking.snapshot();
    const renter = await deps.bookings.renter(b.customerId);
    if (renter === null) throw new RentalRateNotFoundError("Customer");
    const warnings = riskRules(renter);
    const driver = await this.driverOf(
      renter,
      given(request.driverId) ? request.driverId : b.driverId,
    );
    if (driver === null)
      throw new RentalBookingError(
        `Name the driver: ${renter.name} is a company (one of its authorised drivers)`,
      );
    if (driver !== renter) warnings.push(...riskRules(driver));
    if (!driver.hasIdDocument)
      warnings.push(`${driver.name} has no Ghana Card, passport or voter's ID on file`);
    warnings.push(...(await this.licenceRules(driver, b.returnAt)));
    const shortfall = await deps.accounts.depositShortfall(booking, renter);
    if (shortfall > 0) {
      const amount = Money.ofMinor(shortfall, b.currency).format();
      if (request.waiveDeposit !== true)
        throw new RentalBookingError(`Take the security deposit first (${amount} more)`);
      if (!deps.policy.decide(actor, "rentals.price.override", { branchId: b.branchId }).allowed)
        throw new PermissionDeniedError("rentals.price.override");
      warnings.push(`Out without the security deposit (${amount} waived)`);
    }
    return warnings;
  }

  /** Who drives: the individual renter, or the company's authorised driver (null: not named). */
  private async driverOf(renter: Renter, driverId: string | null): Promise<Renter | null> {
    const { deps } = this;
    if (renter.type === "individual") {
      if (driverId !== null && driverId !== renter.id)
        throw new RentalBookingError("Only a company's rental names another driver");
      return renter;
    }
    if (driverId === null) return null;
    if (!(await deps.bookings.isAuthorisedDriver(renter.id, driverId)))
      throw new RentalBookingError(`The driver is not one of ${renter.name}'s authorised drivers`);
    const driver = await deps.bookings.renter(driverId);
    if (driver === null) throw new RentalRateNotFoundError("Driver");
    return driver;
  }

  /** A licence known to expire before the return refuses; an unknown one is a warning. */
  private async licenceRules(driver: Renter, returnAt: Date): Promise<string[]> {
    if (driver.licenceNumber === null || driver.licenceExpiresOn === null)
      return [`${driver.name}'s driving licence is not recorded: check it at the counter`];
    const returnDate = this.local(returnAt, await this.timezone()).slice(0, 10);
    if (driver.licenceExpiresOn < returnDate)
      throw new RentalBookingError(
        `${driver.name}'s licence expires on ${driver.licenceExpiresOn}, before the return`,
      );
    return [];
  }

  private async reach(
    actor: Principal,
    id: string,
    permission: PermissionKey,
    lock = false,
  ): Promise<RentalBooking> {
    const { deps } = this;
    const booking = lock ? await deps.bookings.lock(id) : await deps.bookings.get(id);
    if (
      booking === null ||
      !deps.vehicleAccess.can(actor, "rentals.view", booking.snapshot().branchId)
    )
      throw new RentalBookingNotFoundError();
    deps.policy.require(actor, permission, { branchId: booking.snapshot().branchId });
    return booking;
  }

  private async event(
    booking: RentalBooking,
    type: BookingEventType,
    actor: Principal,
    data: Readonly<Record<string, unknown>>,
  ): Promise<BookingEvent> {
    const event: BookingEvent = {
      id: this.deps.ids.next(),
      bookingId: booking.id,
      type,
      at: this.deps.clock.now(),
      actorId: actor.userId,
      data,
    };
    await this.deps.bookings.addEvent(event);
    return event;
  }

  private async charge(
    booking: RentalBooking,
    event: BookingEvent,
    kind: ChargeKind,
    description: string,
    amount: ChargeAmount,
    actor: Principal,
    damageId: string | null = null,
  ): Promise<void> {
    await this.deps.bookings.addCharge({
      ...amount,
      id: this.deps.ids.next(),
      bookingId: booking.id,
      eventId: event.id,
      kind,
      description,
      damageId,
      createdBy: actor.userId,
      createdAt: this.deps.clock.now(),
    });
  }

  private async view(booking: RentalBooking): Promise<BookingView> {
    const { deps } = this;
    const b = booking.snapshot();
    const vehicle = await deps.blocks.vehicle(b.vehicleId);
    const renter = await deps.bookings.renter(b.customerId);
    const driver = b.driverId === null ? null : await deps.bookings.renter(b.driverId);
    const charges = await deps.bookings.charges(b.id);
    const money = (minor: number) => Money.ofMinor(minor, b.currency);
    return {
      id: b.id,
      number: b.number,
      status: booking.shownStatus(deps.clock.now()),
      branchId: b.branchId,
      customer: { id: b.customerId, name: renter?.name ?? "" },
      driver: b.driverId === null ? null : { id: b.driverId, name: driver?.name ?? "" },
      classId: b.classId,
      byClass: b.byClass,
      vehicle: {
        id: b.vehicleId,
        code: vehicle?.code ?? "",
        plateNumber: vehicle?.plateNumber ?? null,
        make: vehicle?.make ?? "",
        model: vehicle?.model ?? "",
      },
      blockId: b.blockId,
      pickupAt: b.pickupAt,
      returnAt: b.returnAt,
      expiresAt: b.expiresAt,
      currency: b.currency,
      quote: b.quote,
      confirmedAt: b.confirmedAt,
      checkOut:
        b.checkedOutAt === null
          ? null
          : { at: b.checkedOutAt, odometer: b.odometerOut ?? 0, fuel: b.fuelOut },
      return:
        b.returnedAt === null
          ? null
          : {
              at: b.returnedAt,
              odometer: b.odometerIn ?? 0,
              fuel: b.fuelIn,
              km: booking.drivenKm() ?? 0,
            },
      closedAt: b.closedAt,
      cancelledAt: b.cancelledAt,
      cancelReason: b.cancelReason,
      notes: b.notes,
      charges: charges.map((c) => ({
        id: c.id,
        kind: c.kind,
        description: c.description,
        net: money(c.netMinor),
        tax: money(c.taxMinor),
        total: money(c.totalMinor),
        createdAt: c.createdAt,
      })),
      charged: money(sum(charges).totalMinor),
      createdAt: b.createdAt,
    };
  }

  private async detail(
    booking: RentalBooking,
    warnings: readonly string[],
  ): Promise<BookingDetail> {
    return {
      ...(await this.view(booking)),
      events: await this.deps.bookings.events(booking.id),
      documents: await this.deps.agreements.of(booking.id),
      warnings,
    };
  }

  private async timezone(): Promise<string> {
    return (await this.deps.organisation.get()).timezone;
  }

  private local(instant: Date, timezone: string): string {
    const l = localDateTime(instant, timezone);
    return `${l.date} ${String(l.hour).padStart(2, "0")}:${String(l.minute).padStart(2, "0")}`;
  }

  private async audit(
    actor: Principal,
    action: string,
    booking: RentalBooking,
    before: ReturnType<RentalBooking["snapshot"]> | null,
  ): Promise<void> {
    const view = (b: ReturnType<RentalBooking["snapshot"]>) => ({
      number: b.number,
      status: b.status,
      vehicleId: b.vehicleId,
      pickupAt: b.pickupAt.toISOString(),
      returnAt: b.returnAt.toISOString(),
      cancelReason: b.cancelReason,
    });
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: "rental_booking",
      entityId: booking.id,
      before: before === null ? null : view(before),
      after: view(booking.snapshot()),
    });
  }
}

const given = <T>(value: T | null | undefined): value is T => value !== undefined && value !== null;

/** A blacklisted customer or driver is refused; one on watch is a warning (decision 358). */
function riskRules(person: Renter): string[] {
  if (person.riskStatus === "blacklisted")
    throw new RentalBookingError(
      `${person.name} is blacklisted${person.riskReason === null ? "" : `: ${person.riskReason}`}`,
    );
  return person.riskStatus === "watch"
    ? [
        `${person.name} is on the watchlist${person.riskReason === null ? "" : `: ${person.riskReason}`}`,
      ]
    : [];
}

/** The quote as JSON (Money → `{ amountMinor, currency, formatted }`, dates → ISO strings). */
function toJson(quote: RentalQuote): QuoteJson {
  return JSON.parse(JSON.stringify(quote)) as QuoteJson;
}

function jsonAmount(quote: QuoteJson): ChargeAmount {
  const totals = quote.totals as Record<string, { amountMinor: number }>;
  return {
    netMinor: totals.net!.amountMinor,
    taxMinor: totals.tax!.amountMinor,
    totalMinor: totals.total!.amountMinor,
  };
}

function minus(a: ChargeAmount, b: ChargeAmount): ChargeAmount {
  return {
    netMinor: a.netMinor - b.netMinor,
    taxMinor: a.taxMinor - b.taxMinor,
    totalMinor: a.totalMinor - b.totalMinor,
  };
}

function negate(a: ChargeAmount): ChargeAmount {
  return { netMinor: -a.netMinor, taxMinor: -a.taxMinor, totalMinor: -a.totalMinor };
}

function sum(charges: readonly ChargeAmount[]): ChargeAmount {
  return charges.reduce(
    (acc, c) => ({
      netMinor: acc.netMinor + c.netMinor,
      taxMinor: acc.taxMinor + c.taxMinor,
      totalMinor: acc.totalMinor + c.totalMinor,
    }),
    { netMinor: 0, taxMinor: 0, totalMinor: 0 },
  );
}

function isZero(a: ChargeAmount): boolean {
  return a.netMinor === 0 && a.taxMinor === 0 && a.totalMinor === 0;
}

function rentalDescription(quote: RentalQuote): string {
  const time =
    quote.days > 0
      ? `${quote.days} day${quote.days === 1 ? "" : "s"}${quote.hours > 0 ? ` ${quote.hours} h` : ""}`
      : `${quote.hours} hour${quote.hours === 1 ? "" : "s"}`;
  return `Rental, ${quote.plan.name} (${time})`;
}
