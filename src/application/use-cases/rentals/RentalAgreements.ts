import type {
  DocumentStatus,
  IssuedDocumentProps,
} from "../../../domain/documents/IssuedDocument.js";
import { Money } from "../../../domain/money/Money.js";
import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import { RentalBookingError, type RentalBooking } from "../../../domain/rentals/RentalBooking.js";
import type { AuthorizationPolicy } from "../../authorization/AuthorizationPolicy.js";
import type { Principal } from "../../authorization/Principal.js";
import { PermissionDeniedError } from "../../errors/AuthErrors.js";
import type { IBranches } from "../../ports/IBranches.js";
import type { IDocumentRepository, IDocumentSigners } from "../../ports/IDocumentRecords.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IRentalBookings } from "../../ports/IRentalBookings.js";
import type { IRentalInspections, IVehicleDamages } from "../../ports/IRentalInspections.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { localDateTime } from "../../services/TenantLocalTime.js";
import type { Documents } from "../documents/Documents.js";
import type { VehicleAccess } from "../vehicles/VehicleAccess.js";
import { RentalBookingNotFoundError } from "./RentalBookings.js";

export const RENTAL_DOCUMENT_SUBJECT = "rental_booking";
const KINDS = ["rental_agreement", "rental_return"] as const;
export type RentalDocumentType = (typeof KINDS)[number];

/** A booking's document as the counter sees it: who has signed and who still has to. */
export type RentalDocument = Readonly<{
  id: string;
  type: RentalDocumentType;
  number: string;
  status: DocumentStatus;
  issuedAt: Date;
  fullySignedAt: Date | null;
  replacesId: string | null;
  signers: readonly Readonly<{
    id: string;
    role: string;
    label: string;
    name: string;
    status: "pending" | "signed" | "declined";
    signedAt: Date | null;
  }>[];
}>;

type Deps = Readonly<{
  unitOfWork: IUnitOfWork;
  bookings: IRentalBookings;
  inspections: IRentalInspections;
  damages: IVehicleDamages;
  vehicles: IVehicleRepository;
  branches: IBranches;
  documents: Documents;
  issued: IDocumentRepository;
  signers: IDocumentSigners;
  organisation: IOrganisationSettings;
  vehicleAccess: VehicleAccess;
  policy: AuthorizationPolicy;
  ids: IIdGenerator;
  clock: { now(): Date };
}>;

/**
 * The rental agreement and the return note (docs/07 §6, docs/24 §1): issued through the
 * document engine when the keys go out and come back, with the terms, the charges and the
 * handover checklist as recorded, and signed by the renter (through their link, or the QR at
 * the counter) and the agent for the business (decisions 362–368).
 */
export class RentalAgreements {
  constructor(private readonly deps: Deps) {}

  // --- used by the booking lifecycle (inside its unit of work) ---

  /** At check-out, once the inspection is recorded and the booking is out. */
  atCheckOut(actor: Principal, booking: RentalBooking): Promise<RentalDocument> {
    return this.issue(actor, booking, "rental_agreement", null);
  }

  /** At check-in, once the inspection and the return charges are recorded. */
  atCheckIn(actor: Principal, booking: RentalBooking): Promise<RentalDocument> {
    return this.issue(actor, booking, "rental_return", null);
  }

  /** The booking's documents, newest first (voided ones too). */
  async of(bookingId: string): Promise<RentalDocument[]> {
    const { deps } = this;
    const rows = await deps.issued.list({
      branchIds: "all",
      subject: { type: RENTAL_DOCUMENT_SUBJECT, id: bookingId },
      limit: 50,
    });
    const out: RentalDocument[] = [];
    for (const row of rows) {
      const d = row.snapshot();
      if (!isRentalType(d.type)) continue;
      out.push({
        id: d.id,
        type: d.type,
        number: d.number,
        status: d.status,
        issuedAt: d.issuedAt,
        fullySignedAt: d.fullySignedAt,
        replacesId: d.replacesId,
        signers: (await deps.signers.listFor(d.id)).map((x) => {
          const s = x.snapshot();
          return {
            id: s.id,
            role: s.role,
            label: s.label,
            name: s.name,
            status: s.status,
            signedAt: s.signedAt,
          };
        }),
      });
    }
    return out;
  }

  /** What closing the booking should warn about: an agreement or return note not signed. */
  async unsigned(bookingId: string): Promise<string[]> {
    return (await this.of(bookingId))
      .filter((d) => d.status !== "void" && d.fullySignedAt === null)
      .map((d) => `${NAMES[d.type]} ${d.number} is not signed by everyone yet`);
  }

  // --- the counter ---

  /**
   * A new agreement or return note replacing the current one (voided): after an extension, a
   * vehicle or driver change, or a mistake. The signatures start again.
   */
  reissue(actor: Principal, bookingId: string, type: RentalDocumentType): Promise<RentalDocument> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const booking = await deps.bookings.lock(bookingId);
      if (
        booking === null ||
        !deps.vehicleAccess.can(actor, "rentals.view", booking.snapshot().branchId)
      )
        throw new RentalBookingNotFoundError();
      const b = booking.snapshot();
      if (!deps.policy.decide(actor, "rentals.update", { branchId: b.branchId }).allowed)
        throw new PermissionDeniedError("rentals.update");
      const out = b.checkedOutAt !== null && b.status !== "cancelled" && b.status !== "no_show";
      if (type === "rental_agreement" && !out)
        throw new RentalBookingError("The agreement is issued once the vehicle is checked out");
      if (type === "rental_return" && b.returnedAt === null)
        throw new RentalBookingError("The return note is issued once the vehicle is back");
      const current = (await this.of(b.id)).find((d) => d.type === type && d.status !== "void");
      return this.issue(actor, booking, type, current?.id ?? null);
    });
  }

  /** A document of a booking is signed by everyone (document signed listener). */
  async fullySigned(document: IssuedDocumentProps): Promise<void> {
    const { deps } = this;
    if (document.subjectType !== RENTAL_DOCUMENT_SUBJECT) return;
    await deps.bookings.addEvent({
      id: deps.ids.next(),
      bookingId: document.subjectId,
      type: document.type === "rental_agreement" ? "agreement_signed" : "return_signed",
      at: deps.clock.now(),
      actorId: null,
      data: { documentId: document.id, number: document.number },
    });
  }

  // --- helpers ---

  private async issue(
    actor: Principal,
    booking: RentalBooking,
    type: RentalDocumentType,
    replacesId: string | null,
  ): Promise<RentalDocument> {
    const { deps } = this;
    const b = booking.snapshot();
    const renter = await deps.bookings.renter(b.customerId);
    if (renter === null) throw new RentalBookingError("The renter was not found");
    const driver = (b.driverId === null ? null : await deps.bookings.renter(b.driverId)) ?? renter;
    const vehicle = (await deps.vehicles.findById(b.vehicleId))!.snapshot();
    const branch = (await deps.branches.list()).find((x) => x.id === b.branchId)?.name ?? "";
    const { timezone } = await deps.organisation.get();
    const local = (instant: Date) => {
      const l = localDateTime(instant, timezone);
      return { on: l.date, time: `${pad(l.hour)}:${pad(l.minute)}` };
    };
    const money = (minor: number) => Money.ofMinor(minor, b.currency).toJSON();
    const charges = await deps.bookings.charges(b.id);
    const total = charges.reduce((s, c) => s + c.totalMinor, 0);
    const stage = type === "rental_agreement" ? "check_out" : "check_in";
    const inspection = (await deps.inspections.ofBooking(b.id)).find((i) => i.stage === stage);
    const unit = vehicle.mileageUnit;
    const signatory =
      renter.type === "corporate" ? `${driver.name} for ${renter.name}` : renter.name;
    const common = {
      vehicle: {
        code: vehicle.code,
        plateNumber: vehicle.plateNumber,
        make: vehicle.make,
        model: vehicle.model,
        year: vehicle.year,
        colour: vehicle.colour,
        vin: vehicle.vin ?? vehicle.chassisNumber,
        engineNumber: vehicle.engineNumber,
      },
      renter: {
        code: renter.code,
        name: renter.name,
        phone: renter.phone,
        email: renter.email,
        address: renter.address,
      },
      driver: {
        name: driver.name,
        phone: driver.phone,
        ghanaCardNumber: driver.ghanaCardNumber,
        licenceNumber: driver.licenceNumber,
        licenceExpiresOn: driver.licenceExpiresOn,
      },
      checklist: (inspection?.checklist ?? []).map((i) => ({
        label: i.label,
        ok: i.ok,
        note: i.note,
      })),
    };

    let data: Readonly<Record<string, unknown>>;
    if (type === "rental_agreement") {
      const pickup = local(b.checkedOutAt ?? b.pickupAt);
      const due = local(b.returnAt);
      const plan = b.terms.plan;
      const deposit = await deps.bookings.deposit(b.id);
      // The damage map the renter accepts: what is on the vehicle and not yet repaired.
      const open = await deps.damages.list({
        branchIds: "all",
        vehicleId: b.vehicleId,
        statuses: ["open"],
        limit: 100,
      });
      data = {
        ...common,
        rental: {
          number: b.number,
          branch,
          pickupOn: pickup.on,
          pickupTime: pickup.time,
          returnOn: due.on,
          returnTime: due.time,
          plan: plan.name,
          mileage:
            plan.includedKmPerDay === null
              ? "Unlimited"
              : `${plan.includedKmPerDay} ${unit} a day included${
                  plan.extraKmMinor === null
                    ? ""
                    : `, then ${Money.ofMinor(plan.extraKmMinor, b.currency).formatAscii()} a ${unit}`
                }`,
          odometer: b.odometerOut,
          unit,
          fuel: fuelText(b.fuelOut),
          deposit: deposit === null ? null : money(deposit.snapshot().amountMinor),
          total: money(total),
          signatory,
        },
        charges: charges.map((c) => ({ description: c.description, amount: money(c.totalMinor) })),
        damages: open.map((d) => {
          const p = d.snapshot();
          return { area: words(p.area), severity: p.severity, description: p.description };
        }),
      };
    } else {
      const returned = local(b.returnedAt!);
      const due = local(b.returnAt);
      const events = await deps.bookings.events(b.id);
      const returnEvent = events.filter((e) => e.type === "returned").at(-1);
      const agreement = (await this.of(b.id)).find(
        (d) => d.type === "rental_agreement" && d.status !== "void",
      );
      const found = (await deps.damages.list({ branchIds: "all", bookingId: b.id, limit: 100 }))
        .map((d) => d.snapshot())
        .filter((d) => d.foundAt === "check_in");
      data = {
        ...common,
        rental: {
          number: b.number,
          agreementNumber: agreement?.number ?? null,
          branch,
          returnedOn: returned.on,
          returnedTime: returned.time,
          dueOn: due.on,
          dueTime: due.time,
          odometerOut: b.odometerOut,
          odometerIn: b.odometerIn,
          km: Math.max(0, (b.odometerIn ?? 0) - (b.odometerOut ?? 0)),
          unit,
          fuelOut: fuelText(b.fuelOut),
          fuelIn: fuelText(b.fuelIn),
          total: money(total),
          signatory,
        },
        damages: found.map((d) => ({
          area: words(d.area),
          severity: d.severity,
          description: d.description,
          estimate: d.estimateMinor === null ? null : money(d.estimateMinor),
        })),
        charges: charges
          .filter((c) => returnEvent !== undefined && c.eventId === returnEvent.id)
          .map((c) => ({ description: c.description, amount: money(c.totalMinor) })),
      };
    }

    const view = await deps.documents.issue(actor.userId, {
      type,
      subject: { type: RENTAL_DOCUMENT_SUBJECT, id: b.id },
      branchId: b.branchId,
      replacesId,
      data,
      signers: [
        { role: "business", party: { type: "user", id: actor.userId } },
        {
          role: "renter",
          // The person at the counter: the renter, or the company's driver signing for it.
          party: {
            type: "guest",
            name: driver.name,
            phone: driver.phone ?? renter.phone,
            email: driver.email ?? renter.email,
          },
        },
      ],
    });
    await deps.bookings.addEvent({
      id: deps.ids.next(),
      bookingId: b.id,
      type: type === "rental_agreement" ? "agreement_issued" : "return_issued",
      at: deps.clock.now(),
      actorId: actor.userId,
      data: { documentId: view.id, number: view.number, replaces: replacesId },
    });
    return (await this.of(b.id)).find((d) => d.id === view.id)!;
  }
}

const NAMES: Readonly<Record<RentalDocumentType, string>> = {
  rental_agreement: "The rental agreement",
  rental_return: "The return note",
};

const isRentalType = (type: string): type is RentalDocumentType =>
  (KINDS as readonly string[]).includes(type);
const pad = (n: number) => String(n).padStart(2, "0");
const words = (value: string) => value.replaceAll("_", " ");
const fuelText = (fuel: string | null) => (fuel === null ? "not recorded" : words(fuel));
