import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { DriverProps } from "../../../domain/parties/Driver.js";
import type { IDriverRepository } from "../../../domain/repositories/IPartyRepositories.js";
import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import type { ComplianceStatus } from "../../../domain/vehicles/VehicleCompliance.js";
import type { IssueReport } from "../../../domain/vehicles/VehicleIssue.js";
import type { Principal } from "../../authorization/Principal.js";
import type { Page } from "../../dto/Page.js";
import { DriverProfileNotFoundError } from "../../errors/PartyErrors.js";
import type { IAssignmentQueries } from "../../ports/IAssignmentRecords.js";
import type { IDriverAppLinks } from "../../ports/IDriverAppLinks.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { PdfFile, PrintedDocuments } from "../documents/PrintedDocuments.js";
import type { FuelInput, FuelLogs } from "../expenses/FuelLogs.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { DocumentUploadInput } from "../files/OwnedDocuments.js";
import type { DriverLedger, DriverStatement } from "../remittances/DriverLedger.js";
import type { Declaration, RemittanceView, Remittances } from "../remittances/Remittances.js";
import type { VehicleDocuments } from "../vehicles/VehicleDocuments.js";
import type { IssueQuery, VehicleIssues, VehicleIssueView } from "../vehicles/VehicleIssues.js";
import { RemittanceRuleError } from "../../../domain/remittances/Remittance.js";

export type DriverHome = Readonly<{
  driver: Pick<
    DriverProps,
    | "id"
    | "code"
    | "firstName"
    | "lastName"
    | "phone"
    | "status"
    | "licenceNumber"
    | "licenceExpiresOn"
    | "branchId"
  >;
  /** The vehicle they drive now and on what terms. */
  assignment: Readonly<{
    id: string;
    startedAt: Date;
    vehicle: Readonly<{
      id: string;
      code: string;
      plateNumber: string | null;
      make: string;
      model: string;
    }>;
    terms: Readonly<{
      mode: string;
      target: MoneyJson | null;
      frequency: string | null;
      daysOff: readonly number[];
    }>;
  }> | null;
  /** What they owe (positive) or are owed (negative). */
  balance: MoneyJson;
  shortfalls: DriverStatement["shortfalls"];
  /** Periods still open (pending, waiting for approval, short, overdue). */
  openRemittances: readonly RemittanceView[];
}>;

export type DriverVehicle = Readonly<{
  id: string;
  code: string;
  plateNumber: string | null;
  make: string;
  model: string;
  year: number | null;
  colour: string | null;
  fuelType: string | null;
  mileageUnit: "km" | "mi";
  odometer: number | null;
  compliance: ComplianceStatus;
}>;

const OPEN = new Set(["pending", "submitted", "partially_paid", "overdue"]);

/**
 * The driver app (docs/09 §4): everything a signed-in driver may see and do, always about
 * themselves — their vehicle, balance and statement, their remittances (declare what they paid),
 * fuel fills and issue reports for the vehicle they drive, and receipts of their payments. The
 * caller is resolved to their driver profile through the login link; staff permissions play no
 * part.
 */
export class DriverApp {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      links: IDriverAppLinks;
      drivers: IDriverRepository;
      vehicles: IVehicleRepository;
      assignments: IAssignmentQueries;
      documents: VehicleDocuments;
      remittances: Remittances;
      ledger: DriverLedger;
      fuel: FuelLogs;
      issues: VehicleIssues;
      printed: PrintedDocuments;
      posting: LedgerPosting;
      calendar: TenantCalendar;
    }>,
  ) {}

  async home(actor: Principal): Promise<DriverHome> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const driver = await this.me(actor);
      const assignment = await deps.assignments.openForDriver(driver.id);
      const today = await deps.calendar.today();
      const statement = await deps.ledger.statementOf(driver, { from: today, to: today });
      const recent = await deps.remittances.listOwn(driver.id, { limit: 20 });
      const base = await deps.posting.baseCurrency();
      return {
        driver: {
          id: driver.id,
          code: driver.code,
          firstName: driver.firstName,
          lastName: driver.lastName,
          phone: driver.phone,
          status: driver.status,
          licenceNumber: driver.licenceNumber,
          licenceExpiresOn: driver.licenceExpiresOn,
          branchId: driver.branchId,
        },
        assignment:
          assignment === null
            ? null
            : {
                id: assignment.id,
                startedAt: assignment.startedAt,
                vehicle: assignment.vehicle,
                terms: {
                  mode: assignment.terms.mode,
                  target:
                    assignment.terms.targetMinor === null
                      ? null
                      : Money.ofMinor(assignment.terms.targetMinor, base).toJSON(),
                  frequency: assignment.terms.frequency,
                  daysOff: assignment.terms.daysOff,
                },
              },
        balance: statement.closing,
        shortfalls: statement.shortfalls,
        openRemittances: recent.items.filter((r) => OPEN.has(r.status)),
      };
    });
  }

  async vehicle(actor: Principal): Promise<DriverVehicle> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const driver = await this.me(actor);
      const vehicle = await this.currentVehicle(driver.id);
      const v = vehicle.snapshot();
      return {
        id: v.id,
        code: v.code,
        plateNumber: v.plateNumber,
        make: v.make,
        model: v.model,
        year: v.year,
        colour: v.colour,
        fuelType: v.fuelType,
        mileageUnit: v.mileageUnit,
        odometer: v.currentOdometer,
        compliance: await deps.documents.compliance(v.id),
      };
    });
  }

  async ledger(actor: Principal, period: Readonly<{ from?: string; to?: string }>) {
    const driver = await this.deps.unitOfWork.run(() => this.me(actor));
    return this.deps.ledger.statementOf(driver, period);
  }

  async statementPdf(
    actor: Principal,
    period: Readonly<{ from?: string; to?: string }>,
  ): Promise<PdfFile> {
    const driver = await this.deps.unitOfWork.run(() => this.me(actor));
    return this.deps.printed.ownStatement(driver, period);
  }

  async receiptPdf(actor: Principal, paymentId: string): Promise<PdfFile> {
    const driver = await this.deps.unitOfWork.run(() => this.me(actor));
    return this.deps.printed.driverReceipt(driver.id, paymentId);
  }

  // --- remittances ---

  async remittances(
    actor: Principal,
    query: Readonly<{ limit: number; cursor?: string }>,
  ): Promise<Page<RemittanceView>> {
    const driver = await this.deps.unitOfWork.run(() => this.me(actor));
    return this.deps.remittances.listOwn(driver.id, query);
  }

  async remittance(actor: Principal, id: string): Promise<RemittanceView> {
    const driver = await this.deps.unitOfWork.run(() => this.me(actor));
    return this.deps.remittances.getOwn(driver.id, id);
  }

  async declare(actor: Principal, id: string, declaration: Declaration): Promise<RemittanceView> {
    return this.deps.unitOfWork.run(async () => {
      const driver = await this.me(actor);
      return this.deps.remittances.submitOwn(actor, driver.id, id, declaration);
    });
  }

  /** Variable mode: the driver declares a period of the vehicle they drive. */
  async declarePeriod(
    actor: Principal,
    input: Readonly<{ periodStart: string; periodEnd: string } & Declaration>,
  ): Promise<RemittanceView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const driver = await this.me(actor);
      const assignment = await deps.assignments.openForDriver(driver.id);
      if (assignment === null)
        throw new RemittanceRuleError("You have no vehicle to declare a period for");
      return deps.remittances.declareOwn(actor, driver.id, {
        ...input,
        vehicleId: assignment.vehicleId,
      });
    });
  }

  // --- fuel and issues ---

  async fuel(
    actor: Principal,
    input: Omit<FuelInput, "driverId" | "supplierId"> & Readonly<{ paidByDriver: boolean }>,
  ) {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const driver = await this.me(actor);
      const vehicle = await this.currentVehicle(driver.id, true);
      return deps.fuel.recordByDriver(actor.userId, vehicle, driver.id, input);
    });
  }

  async reportIssue(actor: Principal, input: IssueReport): Promise<VehicleIssueView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const driver = await this.me(actor);
      const vehicle = await this.currentVehicle(driver.id);
      return deps.issues.reportAsDriver(actor.userId, driver.id, vehicle, input);
    });
  }

  async issues(actor: Principal, query: Omit<IssueQuery, "driverId" | "branchId">) {
    const driver = await this.deps.unitOfWork.run(() => this.me(actor));
    return this.deps.issues.listOwn(driver.id, query);
  }

  async issue(actor: Principal, id: string): Promise<VehicleIssueView> {
    const driver = await this.deps.unitOfWork.run(() => this.me(actor));
    return this.deps.issues.getOwn(driver.id, id);
  }

  async startIssuePhoto(actor: Principal, id: string, input: DocumentUploadInput) {
    const driver = await this.deps.unitOfWork.run(() => this.me(actor));
    return this.deps.issues.startOwnPhoto(actor.userId, driver.id, id, input);
  }

  async completeIssuePhoto(actor: Principal, id: string, fileId: string) {
    const driver = await this.deps.unitOfWork.run(() => this.me(actor));
    return this.deps.issues.completeOwnPhoto(driver.id, id, fileId);
  }

  /** The caller's driver profile (not removed); 404 for a login without one. */
  private async me(actor: Principal): Promise<DriverProps> {
    const driverId = await this.deps.links.driverOf(actor.userId);
    const driver = driverId === null ? null : await this.deps.drivers.findById(driverId);
    if (driver === null) throw new DriverProfileNotFoundError();
    return driver.snapshot();
  }

  private async currentVehicle(driverId: string, lock = false) {
    const assignment = await this.deps.assignments.openForDriver(driverId);
    const vehicle =
      assignment === null
        ? null
        : lock
          ? await this.deps.vehicles.lockById(assignment.vehicleId)
          : await this.deps.vehicles.findById(assignment.vehicleId);
    if (vehicle === null)
      throw new RemittanceRuleError("You have no vehicle assigned to you right now");
    return vehicle;
  }
}
