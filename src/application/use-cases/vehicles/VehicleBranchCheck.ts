import type { IBranchDeactivationCheck } from "../../ports/IBranches.js";
import type { IVehicleQueries } from "../../ports/IVehicleRecords.js";

/**
 * A branch is deactivated only once its vehicles are transferred (docs/27 §3.5): nothing live
 * may be left in a branch no one can reach. Vehicles that left the fleet do not count.
 */
export class VehicleBranchCheck implements IBranchDeactivationCheck {
  readonly name = "vehicles";

  constructor(private readonly queries: IVehicleQueries) {}

  async check(branchId: string): Promise<string | null> {
    const count = await this.queries.countInBranch(branchId);
    if (count === 0) return null;
    return `${count} vehicle${count === 1 ? " is" : "s are"} still in this branch — transfer ${count === 1 ? "it" : "them"} to another branch first`;
  }
}
