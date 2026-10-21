import { Money } from "../../../domain/money/Money.js";
import type { IDriverRepository } from "../../../domain/repositories/IPartyRepositories.js";
import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import type { Principal } from "../../authorization/Principal.js";
import { AssignmentNotFoundError } from "../../errors/AssignmentErrors.js";
import type { IAssignmentQueries } from "../../ports/IAssignmentRecords.js";
import type { IBranches } from "../../ports/IBranches.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import type { DocumentView, Documents } from "../documents/Documents.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MODES: Readonly<Record<string, string>> = {
  fixed_target: "Fixed target",
  variable: "Variable",
  none: "No remittance",
};
const EVERY: Readonly<Record<string, string>> = {
  daily: "every day",
  weekly: "every week",
  monthly: "every month",
};

/**
 * The handover document of an assignment (docs/06 §6, docs/24 §1): the vehicle, the driver, the
 * odometer, the checklist as it was ticked and the remittance terms, snapshotted and printed
 * for both sides to sign.
 */
export class HandoverDocuments {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      assignments: IAssignmentQueries;
      vehicles: IVehicleRepository;
      drivers: IDriverRepository;
      branches: IBranches;
      documents: Documents;
      posting: LedgerPosting;
      scope: BranchScope;
    }>,
  ) {}

  async issue(
    actor: Principal,
    assignmentId: string,
    replacesId: string | null,
  ): Promise<DocumentView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const a = await deps.assignments.get(assignmentId);
      if (a === null) throw new AssignmentNotFoundError();
      await deps.scope.assertReaches(
        actor,
        "documents.issue",
        a.branchId,
        () => new AssignmentNotFoundError(),
      );
      const vehicle = (await deps.vehicles.findById(a.vehicleId))!.snapshot();
      const driver = (await deps.drivers.findById(a.driverId))!.snapshot();
      const branch = (await deps.branches.list()).find((b) => b.id === a.branchId);
      const base = await deps.posting.baseCurrency();
      return deps.documents.issue(actor.userId, {
        type: "vehicle_handover",
        subject: { type: "vehicle_assignment", id: a.id },
        branchId: a.branchId,
        replacesId,
        data: {
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
          driver: {
            code: driver.code,
            name: `${driver.firstName} ${driver.lastName}`,
            phone: driver.phone,
            address: driver.address,
            ghanaCardNumber: driver.ghanaCardNumber,
            licenceNumber: driver.licenceNumber,
          },
          handover: {
            startedAt: a.startedAt.toISOString(),
            odometer: a.startOdometer,
            unit: vehicle.mileageUnit,
            branch: branch?.name ?? "",
          },
          terms: {
            mode: MODES[a.terms.mode] ?? a.terms.mode,
            target:
              a.terms.targetMinor === null
                ? null
                : Money.ofMinor(a.terms.targetMinor, base).toJSON(),
            frequency:
              a.terms.frequency === null ? null : (EVERY[a.terms.frequency] ?? a.terms.frequency),
            daysOff: a.terms.daysOff.map((d) => DAYS[d]).join(", ") || null,
          },
          checklist: a.startChecklist.items.map((i) => ({
            label: i.label,
            ok: i.ok,
            note: i.note,
          })),
        },
      });
    });
  }
}
