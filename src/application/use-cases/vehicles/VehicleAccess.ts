import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import type { Vehicle } from "../../../domain/vehicles/Vehicle.js";
import type { AuthorizationPolicy } from "../../authorization/AuthorizationPolicy.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { BranchView, IBranches } from "../../ports/IBranches.js";
import { BranchScope } from "../../services/BranchScope.js";

export class VehicleNotFoundError extends ApplicationError {
  readonly code = "VEHICLE_NOT_FOUND";
  constructor() {
    super("Vehicle not found");
  }
}

/** Another vehicle already has this plate or VIN (409). */
export class VehicleExistsError extends ApplicationError {
  readonly code = "VEHICLE_EXISTS";
  constructor(what: "plate number" | "VIN", value: string) {
    super(`Another vehicle already has the ${what} ${value}`);
  }
}

/**
 * Branch scope for vehicles (docs/28 rule 14, docs/27 §3.5): a vehicle outside the caller's
 * branches does not exist for them; a vehicle of a deactivated branch is refused even with
 * all-branch access.
 */
export class VehicleAccess {
  private readonly scope: BranchScope;

  constructor(
    private readonly deps: Readonly<{
      vehicles: IVehicleRepository;
      branches: IBranches;
      policy: AuthorizationPolicy;
    }>,
  ) {
    this.scope = new BranchScope({ branches: deps.branches, policy: deps.policy });
  }

  async reach(
    actor: Principal,
    id: string,
    permission: PermissionKey,
    lock = false,
  ): Promise<Vehicle> {
    const { deps } = this;
    const vehicle = lock ? await deps.vehicles.lockById(id) : await deps.vehicles.findById(id);
    if (vehicle === null) throw new VehicleNotFoundError();
    await this.scope.assertReaches(
      actor,
      permission,
      vehicle.branchId,
      () => new VehicleNotFoundError(),
    );
    return vehicle;
  }

  /** The branch exists, is active and is within the caller's scope for `permission`. */
  branch(actor: Principal, permission: PermissionKey, branchId: string): Promise<BranchView> {
    return this.scope.branch(actor, permission, branchId);
  }

  /** The default branch, or the caller's only branch, for records created without one. */
  defaultBranch(actor: Principal, permission: PermissionKey): Promise<string> {
    return this.scope.defaultBranch(actor, permission, "vehicle");
  }

  /** Cost, book value and residual value (sensitive) for a vehicle in `branchId`. */
  canSeeFinancials(actor: Principal, branchId: string): boolean {
    return this.can(actor, "vehicles.financials.view", branchId);
  }

  can(actor: Principal, permission: PermissionKey, branchId: string): boolean {
    return this.scope.can(actor, permission, branchId);
  }

  branchesFor(actor: Principal, permission: PermissionKey): "all" | readonly string[] {
    return this.scope.branchesFor(actor, permission);
  }
}
