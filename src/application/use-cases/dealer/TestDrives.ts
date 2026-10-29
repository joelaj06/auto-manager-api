import {
  TestDrive,
  TestDriveRuleError,
  type TestDriveProps,
  type TestDriveStatus,
} from "../../../domain/dealer/TestDrive.js";
import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import { PhoneNumber } from "../../../domain/value-objects/PhoneNumber.js";
import type { Principal } from "../../authorization/Principal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { ILeads, ITestDrives } from "../../ports/IDealerSales.js";
import type { IDealerStock } from "../../ports/IDealerStock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IRecipientDirectory } from "../../ports/INotifications.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import { localDateTime } from "../../services/TenantLocalTime.js";
import type { Documents } from "../documents/Documents.js";
import type { RentalAvailability } from "../rentals/RentalAvailability.js";
import { recordUserAction } from "../reference/userAudit.js";
import { LeadNotFoundError, noteOnLead, reachesLead } from "./DealerLeads.js";

export class TestDriveNotFoundError extends ApplicationError {
  readonly code = "TEST_DRIVE_NOT_FOUND";
  constructor() {
    super("Test drive not found");
  }
}

/** Stock a customer may drive: ready or on sale (decision 441). */
const DRIVABLE = new Set(["ready", "listed"]);
const SUBJECT = "dealer_test_drive";

export type BookTestDriveInput = Readonly<{
  vehicleId: string;
  leadId?: string | null;
  startsAt: Date;
  endsAt: Date;
  driverName?: string;
  driverPhone?: string;
  licenceNumber: string;
  licenceExpiresOn: string;
  /** Default: whoever books it. */
  accompaniedBy?: string;
  notes?: string | null;
}>;

export type TestDriveQuery = Readonly<{
  vehicleId?: string;
  leadId?: string;
  statuses?: readonly TestDriveStatus[];
  from?: Date;
  until?: Date;
  limit: number;
  beforeId?: string;
}>;

/**
 * Test drives (docs/10 §5): booked on a ready or listed stock vehicle with a block that keeps
 * rentals and other drives off it, the licence valid on the day, a member of staff along, a
 * waiver issued for signature when the car goes out, the odometer out and back, and the lead's
 * log and stage kept up (decisions 437–444).
 */
export class TestDrives {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      drives: ITestDrives;
      leads: ILeads;
      stock: IDealerStock;
      vehicles: IVehicleRepository;
      availability: RentalAvailability;
      documents: Documents;
      recipients: IRecipientDirectory;
      organisation: IOrganisationSettings;
      scope: BranchScope;
      calendar: TenantCalendar;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  list(actor: Principal, query: TestDriveQuery): Promise<TestDriveProps[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () =>
      (
        await deps.drives.list({
          ...query,
          branchIds: deps.scope.branchesFor(actor, "dealer.testdrives.manage"),
        })
      ).map((d) => d.snapshot()),
    );
  }

  get(actor: Principal, id: string): Promise<TestDriveProps> {
    return this.deps.unitOfWork.run(async () => (await this.reach(actor, id)).snapshot());
  }

  book(actor: Principal, input: BookTestDriveInput): Promise<TestDriveProps> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const record = await deps.stock.record(input.vehicleId);
      if (
        record === null ||
        !deps.scope.can(actor, "dealer.testdrives.manage", record.vehicle.branchId)
      )
        throw new TestDriveRuleError("The vehicle is not in your stock");
      if (!DRIVABLE.has(record.unit.status))
        throw new TestDriveRuleError(`The vehicle is ${record.unit.status}: it is not driven`);
      const branchId = record.vehicle.branchId;
      const now = deps.clock.now();
      if (input.startsAt < new Date(now.getTime() - 15 * 60_000))
        throw new TestDriveRuleError("Book a time from now on");

      let lead = null;
      if (input.leadId !== undefined && input.leadId !== null) {
        lead = await deps.leads.get(input.leadId);
        if (lead === null || !reachesLead(actor, deps.scope, "dealer.leads.view", lead))
          throw new LeadNotFoundError();
      }
      const l = lead?.snapshot();
      const driverName = input.driverName ?? l?.name;
      const phone = input.driverPhone ?? l?.phone;
      if (driverName === undefined || phone === undefined || phone === null)
        throw new TestDriveRuleError("Give the driver's name and phone number");
      const { timezone } = await deps.organisation.get();
      if (input.licenceExpiresOn < localDateTime(input.startsAt, timezone).date)
        throw new TestDriveRuleError("The driver's licence will have expired by then");

      const accompaniedBy = input.accompaniedBy ?? actor.userId;
      if (accompaniedBy !== actor.userId) {
        const staff = await deps.recipients.staffWith("dealer.testdrives.manage", branchId);
        if (!staff.some((s) => s.userId === accompaniedBy))
          throw new TestDriveRuleError("The person going along must handle test drives there");
      }
      const id = deps.ids.next();
      const block = await deps.availability.place(
        {
          vehicleId: input.vehicleId,
          branchId,
          reason: "test_drive",
          status: "confirmed",
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          customerId: l?.customerId ?? null,
          refType: SUBJECT,
          refId: id,
          note: `Test drive: ${driverName}`,
        },
        actor.userId,
      );
      const drive = TestDrive.book({
        id,
        branchId,
        vehicleId: input.vehicleId,
        leadId: lead?.id ?? null,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        driverName,
        driverPhone: PhoneNumber.parse(phone).value,
        licenceNumber: input.licenceNumber,
        licenceExpiresOn: input.licenceExpiresOn,
        accompaniedBy,
        blockId: block.id,
        notes: input.notes ?? null,
        createdBy: actor.userId,
        now,
      });
      await deps.drives.insert(drive);
      if (lead !== null) {
        const v = record.vehicle;
        await noteOnLead(deps, lead.id, {
          kind: "test_drive",
          note: `Test drive booked: ${v.make} ${v.model} (${v.plateNumber ?? v.code})`,
          details: { testDriveId: id, vehicleId: input.vehicleId, status: "booked" },
          userId: actor.userId,
          advanceTo: "appointment",
        });
      }
      await this.audit(actor, "test_drive.booked", drive);
      return drive.snapshot();
    });
  }

  /** The car goes out: the licence still valid today, the waiver issued for both to sign. */
  start(
    actor: Principal,
    id: string,
    input: Readonly<{ odometer: number }>,
  ): Promise<TestDriveProps> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const drive = await this.reach(actor, id, true);
      const d = drive.snapshot();
      const today = await deps.calendar.today();
      if (d.licenceExpiresOn < today)
        throw new TestDriveRuleError("The driver's licence has expired");
      const vehicle = await deps.vehicles.findById(d.vehicleId);
      const v = vehicle!.snapshot();
      const { timezone } = await deps.organisation.get();
      const staff = await deps.recipients.users([d.accompaniedBy]);
      const when = (at: Date) => {
        const t = localDateTime(at, timezone);
        return `${t.date} ${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
      };
      const waiver = await deps.documents.issue(actor.userId, {
        type: "test_drive_waiver",
        subject: { type: SUBJECT, id: drive.id },
        branchId: d.branchId,
        data: {
          vehicle: {
            code: v.code,
            plateNumber: v.plateNumber,
            make: v.make,
            model: v.model,
            year: v.year,
            colour: v.colour,
            vin: v.vin,
            engineNumber: v.engineNumber,
          },
          driver: {
            name: d.driverName,
            phone: d.driverPhone,
            licenceNumber: d.licenceNumber,
            licenceExpiresOn: d.licenceExpiresOn,
          },
          drive: {
            startsAt: when(d.startsAt),
            endsAt: when(d.endsAt),
            accompaniedBy: staff[0]?.name ?? "Staff",
            odometerOut: input.odometer,
          },
        },
        signers: [
          { role: "business", party: { type: "user", id: d.accompaniedBy } },
          {
            role: "driver",
            party: { type: "guest", name: d.driverName, phone: d.driverPhone },
          },
        ],
      });
      drive.start(
        { odometer: input.odometer, today, waiverDocumentId: waiver.id },
        deps.clock.now(),
      );
      await deps.availability.setStatus(d.blockId, "out", null);
      await deps.drives.update(drive);
      await this.audit(actor, "test_drive.started", drive);
      return drive.snapshot();
    });
  }

  finish(
    actor: Principal,
    id: string,
    input: Readonly<{ odometer: number; feedback?: string | null }>,
  ): Promise<TestDriveProps> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const drive = await this.reach(actor, id, true);
      const km = drive.finish(input.odometer, input.feedback ?? null, deps.clock.now());
      await deps.availability.free(drive.snapshot().blockId, "Test drive over", actor.userId);
      await deps.drives.update(drive);
      const d = drive.snapshot();
      if (d.leadId !== null)
        await noteOnLead(deps, d.leadId, {
          kind: "test_drive",
          note: `Test drive done (${km} driven)${d.feedback === null ? "" : `: ${d.feedback}`}`,
          details: { testDriveId: d.id, vehicleId: d.vehicleId, status: "returned", distance: km },
          userId: actor.userId,
          advanceTo: "test_drive",
        });
      await this.audit(actor, "test_drive.returned", drive);
      return d;
    });
  }

  cancel(
    actor: Principal,
    id: string,
    input: Readonly<{ status: "cancelled" | "no_show"; reason?: string | null }>,
  ): Promise<TestDriveProps> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const drive = await this.reach(actor, id, true);
      drive.cancel(input.status, input.reason ?? null, deps.clock.now());
      await deps.availability.free(
        drive.snapshot().blockId,
        input.status === "no_show" ? "Driver did not come" : "Test drive cancelled",
        actor.userId,
      );
      await deps.drives.update(drive);
      const d = drive.snapshot();
      if (d.leadId !== null)
        await noteOnLead(deps, d.leadId, {
          kind: "test_drive",
          note:
            input.status === "no_show"
              ? "Did not come to the test drive"
              : `Test drive cancelled: ${d.cancelReason}`,
          details: { testDriveId: d.id, vehicleId: d.vehicleId, status: input.status },
          userId: actor.userId,
        });
      await this.audit(actor, `test_drive.${input.status}`, drive);
      return d;
    });
  }

  private async reach(actor: Principal, id: string, lock = false): Promise<TestDrive> {
    const { deps } = this;
    const drive = lock ? await deps.drives.lock(id) : await deps.drives.get(id);
    if (
      drive === null ||
      !deps.scope.can(actor, "dealer.testdrives.manage", drive.snapshot().branchId)
    )
      throw new TestDriveNotFoundError();
    return drive;
  }

  private async audit(actor: Principal, action: string, drive: TestDrive): Promise<void> {
    const d = drive.snapshot();
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: SUBJECT,
      entityId: drive.id,
      after: { status: d.status, vehicleId: d.vehicleId, startsAt: d.startsAt.toISOString() },
    });
  }
}
