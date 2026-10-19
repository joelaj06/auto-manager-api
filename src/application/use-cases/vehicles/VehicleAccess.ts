import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import type { Vehicle } from "../../../domain/vehicles/Vehicle.js";
import type { AuthorizationPolicy } from "../../authorization/AuthorizationPolicy.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import { IdentityRuleError } from "../../errors/IdentityErrors.js";
import { BranchDeactivatedError } from "../../errors/TenantErrors.js";
import type { BranchView, IBranches } from "../../ports/IBranches.js";

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
  constructor(
    private readonly deps: Readonly<{
      vehicles: IVehicleRepository;
      branches: IBranches;
      policy: AuthorizationPolicy;
    }>,
  ) {}

  async reach(
    actor: Principal,
    id: string,
    permission: PermissionKey,
    lock = false,
  ): Promise<Vehicle> {
    const { deps } = this;
    const vehicle = lock ? await deps.vehicles.lockById(id) : await deps.vehicles.findById(id);
    if (vehicle === null) throw new VehicleNotFoundError();
    const reachable = deps.policy.branchesFor(actor, permission);
    if (reachable !== "all") {
      if (!reachable.includes(vehicle.branchId)) throw new VehicleNotFoundError();
      return vehicle;
    }
    const branch = (await deps.branches.list()).find((b) => b.id === vehicle.branchId);
    if (branch?.status !== "active") throw new BranchDeactivatedError();
    return vehicle;
  }

  /** The branch exists, is active and is within the caller's scope for `permission`. */
  async branch(actor: Principal, permission: PermissionKey, branchId: string): Promise<BranchView> {
    const branch = (await this.deps.branches.list()).find((b) => b.id === branchId);
    if (branch === undefined) throw new IdentityRuleError("UNKNOWN_BRANCH", "Unknown branch");
    if (branch.status !== "active") throw new BranchDeactivatedError();
    const reachable = this.deps.policy.branchesFor(actor, permission);
    if (reachable !== "all" && !reachable.includes(branchId))
      throw new IdentityRuleError("BRANCH_OUT_OF_SCOPE", "You can only use branches you manage");
    return branch;
  }

  /** The default branch, or the caller's only branch, for records created without one. */
  async defaultBranch(actor: Principal, permission: PermissionKey): Promise<string> {
    const reachable = this.deps.policy.branchesFor(actor, permission);
    if (reachable !== "all") {
      if (reachable.length === 1) return reachable[0]!;
      throw new IdentityRuleError("UNKNOWN_BRANCH", "Choose the branch of the vehicle");
    }
    const branch = (await this.deps.branches.list()).find(
      (b) => b.isDefault && b.status === "active",
    );
    if (branch === undefined)
      throw new IdentityRuleError("UNKNOWN_BRANCH", "Choose the branch of the vehicle");
    return branch.id;
  }

  /** Cost, book value and residual value (sensitive) for a vehicle in `branchId`. */
  canSeeFinancials(actor: Principal, branchId: string): boolean {
    return this.can(actor, "vehicles.financials.view", branchId);
  }

  can(actor: Principal, permission: PermissionKey, branchId: string): boolean {
    return this.deps.policy.decide(actor, permission, { branchId }).allowed;
  }

  branchesFor(actor: Principal, permission: PermissionKey): "all" | readonly string[] {
    return this.deps.policy.branchesFor(actor, permission);
  }
}
