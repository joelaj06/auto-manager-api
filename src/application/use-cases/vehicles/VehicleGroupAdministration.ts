import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import { InvalidVehicleError } from "../../../domain/vehicles/VehicleIdentifiers.js";
import type { Principal } from "../../authorization/Principal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { IVehicleGroups, VehicleGroup } from "../../ports/IVehicleRecords.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { VehicleAccess } from "./VehicleAccess.js";

export class VehicleGroupNotFoundError extends ApplicationError {
  readonly code = "VEHICLE_GROUP_NOT_FOUND";
  constructor() {
    super("Vehicle group not found");
  }
}

export class VehicleGroupNameTakenError extends ApplicationError {
  readonly code = "VEHICLE_GROUP_NAME_TAKEN";
  constructor(name: string) {
    super(`A group named ${name} already exists`);
  }
}

const MAX_MEMBERS_CHANGE = 200;

/**
 * Vehicle groups (docs/06 §2 classification): named sets such as "Uber fleet" or "Kumasi buses"
 * for filtering, reports and later rules. A vehicle can be in several groups.
 */
export class VehicleGroupAdministration {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      groups: IVehicleGroups;
      vehicles: IVehicleRepository;
      access: VehicleAccess;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  list(): Promise<VehicleGroup[]> {
    return this.deps.unitOfWork.run(() => this.deps.groups.list());
  }

  async create(
    actor: Principal,
    input: Readonly<{ name: string; description?: string | null }>,
  ): Promise<VehicleGroup> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const group = { id: deps.ids.next(), ...checked(input.name, input.description ?? null) };
      if (await deps.groups.nameTaken(group.name, null))
        throw new VehicleGroupNameTakenError(group.name);
      await deps.groups.save(group);
      await recordUserAction(deps, actor.userId, {
        action: "vehicle_group.created",
        entityType: "vehicle_group",
        entityId: group.id,
        after: group,
      });
      return (await deps.groups.get(group.id))!;
    });
  }

  async update(
    actor: Principal,
    id: string,
    changes: Readonly<{ name?: string; description?: string | null }>,
  ): Promise<VehicleGroup> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await this.find(id);
      const after = {
        id,
        ...checked(
          changes.name ?? before.name,
          changes.description === undefined ? before.description : changes.description,
        ),
      };
      if (after.name !== before.name && (await deps.groups.nameTaken(after.name, id)))
        throw new VehicleGroupNameTakenError(after.name);
      await deps.groups.save(after);
      await recordUserAction(deps, actor.userId, {
        action: "vehicle_group.updated",
        entityType: "vehicle_group",
        entityId: id,
        before,
        after,
      });
      return (await deps.groups.get(id))!;
    });
  }

  /** Deletes the group; its vehicles stay, only the membership goes. */
  async remove(actor: Principal, id: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const group = await this.find(id);
      await deps.groups.remove(id);
      await recordUserAction(deps, actor.userId, {
        action: "vehicle_group.deleted",
        entityType: "vehicle_group",
        entityId: id,
        before: group,
      });
    });
  }

  /** Adds and removes vehicles (within the caller's branches) in one go. */
  async changeMembers(
    actor: Principal,
    id: string,
    input: Readonly<{ add?: readonly string[]; remove?: readonly string[] }>,
  ): Promise<VehicleGroup> {
    const { deps } = this;
    const add = new Set(input.add ?? []);
    const remove = new Set(input.remove ?? []);
    if (add.size + remove.size === 0 || add.size + remove.size > MAX_MEMBERS_CHANGE)
      throw new InvalidVehicleError(`Change 1 to ${MAX_MEMBERS_CHANGE} vehicles at a time`);
    return deps.unitOfWork.run(async () => {
      await this.find(id);
      const now = deps.clock.now();
      for (const vehicleId of new Set([...add, ...remove])) {
        const vehicle = await deps.access.reach(actor, vehicleId, "vehicles.update", true);
        const current = vehicle.snapshot().groupIds.filter((g) => g !== id);
        vehicle.setGroups(
          add.has(vehicleId) && !remove.has(vehicleId) ? [...current, id] : current,
          now,
        );
        await deps.vehicles.save(vehicle);
      }
      await recordUserAction(deps, actor.userId, {
        action: "vehicle_group.members_changed",
        entityType: "vehicle_group",
        entityId: id,
        after: { added: [...add], removed: [...remove] },
      });
      return (await deps.groups.get(id))!;
    });
  }

  private async find(id: string): Promise<VehicleGroup> {
    const group = await this.deps.groups.get(id);
    if (group === null) throw new VehicleGroupNotFoundError();
    return group;
  }
}

function checked(name: string, description: string | null) {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 80)
    throw new InvalidVehicleError("A group name has 1 to 80 characters");
  const text = description?.trim() ?? "";
  if (text.length > 500) throw new InvalidVehicleError("Keep the description under 500 characters");
  return { name: trimmed, description: text === "" ? null : text };
}
