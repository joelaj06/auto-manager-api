import { pageOf, pageWindow, type Page, type Paging } from "../../dto/Page.js";
import { randomBytes } from "node:crypto";
import {
  TelematicsRuleError,
  checkGeofenceShape,
  type GeofenceAlert,
  type GeofenceShape,
} from "../../../domain/telematics/Geo.js";
import type { Principal } from "../../authorization/Principal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type {
  DeviceChanges,
  DeviceFilter,
  GeofenceView,
  ITelematics,
  TelematicsConnection,
  TelematicsDevice,
  TelematicsProvider,
  TelematicsSettings,
  TelematicsSettingsInput,
} from "../../ports/ITelematics.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { VehicleAccess } from "../vehicles/VehicleAccess.js";
import { tokenHash } from "./TelematicsIngestion.js";

export class TelematicsNotFoundError extends ApplicationError {
  readonly code = "TELEMATICS_NOT_FOUND";
  constructor(what: "connection" | "tracker" | "geofence" | "event") {
    super(`No such ${what}`);
  }
}

/** A new or rotated connection: the token is shown this once. */
export type ConnectionWithToken = Readonly<{
  connection: TelematicsConnection;
  token: string;
  ingestUrl: string;
}>;

export type GeofenceInputs = Readonly<{
  name: string;
  shape: GeofenceShape;
  branchId: string | null;
  alertOn: GeofenceAlert;
  active: boolean;
}>;

const newToken = () => `afgps_${randomBytes(30).toString("base64url")}`;
const MAX_CONNECTIONS = 20;

/**
 * Setting up telematics (docs/06 §9, decision 504): connections to providers with a secret
 * token for each (kept as a hash, shown once, rotated at will), trackers matched to vehicles one
 * to one, the thresholds (speed limit, retention, working day) and geofences. Linking a tracker
 * to another vehicle starts its trips and geofence states afresh.
 */
export class TelematicsSetup {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      telematics: ITelematics;
      vehicleAccess: VehicleAccess;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
      /** Where the provider sends positions: the business's own address. */
      ingestUrl: (connectionId: string) => Promise<string>;
    }>,
  ) {}

  settings(): Promise<TelematicsSettings> {
    return this.deps.unitOfWork.run(() => this.deps.telematics.settings());
  }

  updateSettings(actor: Principal, input: TelematicsSettingsInput): Promise<TelematicsSettings> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await deps.telematics.settings();
      await deps.telematics.saveSettings(input, actor.userId);
      await recordUserAction(deps, actor.userId, {
        action: "telematics.settings_updated",
        entityType: "telematics_settings",
        entityId: null,
        before: { ...before, updatedAt: before.updatedAt.toISOString() },
        after: { ...input },
      });
      return deps.telematics.settings();
    });
  }

  // --- connections ---

  connections(): Promise<TelematicsConnection[]> {
    return this.deps.unitOfWork.run(() => this.deps.telematics.connections());
  }

  async connection(id: string): Promise<TelematicsConnection & Readonly<{ ingestUrl: string }>> {
    const found = await this.deps.unitOfWork.run(() => this.deps.telematics.connection(id));
    if (found === null) throw new TelematicsNotFoundError("connection");
    return { ...found, ingestUrl: await this.deps.ingestUrl(found.id) };
  }

  createConnection(
    actor: Principal,
    input: Readonly<{ name: string; provider: TelematicsProvider }>,
  ): Promise<ConnectionWithToken> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const name = input.name.trim();
      if ((await deps.telematics.connections()).length >= MAX_CONNECTIONS)
        throw new TelematicsRuleError(`A business has at most ${MAX_CONNECTIONS} connections`);
      if (await deps.telematics.nameTaken(name, null))
        throw new TelematicsRuleError(`A connection called ${name} exists`);
      const id = deps.ids.next();
      const token = newToken();
      await deps.telematics.createConnection({
        id,
        name,
        provider: input.provider,
        tokenHash: tokenHash(token),
        tokenHint: token.slice(-4),
        createdBy: actor.userId,
      });
      await recordUserAction(deps, actor.userId, {
        action: "telematics.connection_created",
        entityType: "telematics_connection",
        entityId: id,
        after: { name, provider: input.provider },
      });
      return {
        connection: (await deps.telematics.connection(id))!,
        token,
        ingestUrl: await deps.ingestUrl(id),
      };
    });
  }

  updateConnection(
    actor: Principal,
    id: string,
    changes: Readonly<{ name?: string; status?: "active" | "disabled" }>,
  ): Promise<TelematicsConnection> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await deps.telematics.connection(id);
      if (before === null) throw new TelematicsNotFoundError("connection");
      const name = changes.name?.trim();
      if (name !== undefined && (await deps.telematics.nameTaken(name, id)))
        throw new TelematicsRuleError(`A connection called ${name} exists`);
      await deps.telematics.updateConnection(id, {
        ...(name === undefined ? {} : { name }),
        ...(changes.status === undefined ? {} : { status: changes.status }),
      });
      await recordUserAction(deps, actor.userId, {
        action: "telematics.connection_updated",
        entityType: "telematics_connection",
        entityId: id,
        before: { name: before.name, status: before.status },
        after: { ...changes },
      });
      return (await deps.telematics.connection(id))!;
    });
  }

  /** A new token; the old one stops working at once. */
  rotateToken(actor: Principal, id: string): Promise<ConnectionWithToken> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if ((await deps.telematics.connection(id)) === null)
        throw new TelematicsNotFoundError("connection");
      const token = newToken();
      await deps.telematics.updateConnection(id, {
        tokenHash: tokenHash(token),
        tokenHint: token.slice(-4),
      });
      await recordUserAction(deps, actor.userId, {
        action: "telematics.token_rotated",
        entityType: "telematics_connection",
        entityId: id,
      });
      return {
        connection: (await deps.telematics.connection(id))!,
        token,
        ingestUrl: await deps.ingestUrl(id),
      };
    });
  }

  // --- trackers ---

  devices(
    actor: Principal,
    filter: Paging<Omit<DeviceFilter, "branchIds">>,
  ): Promise<Page<TelematicsDevice>> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const branchIds = deps.vehicleAccess.branchesFor(actor, "telematics.view");
      // Trackers not on a vehicle belong to no branch: business-wide access sees them.
      if (filter.unlinked === true && branchIds !== "all")
        return pageOf(filter, { rows: [], total: 0 });
      return pageOf(
        filter,
        await deps.telematics.devices({ ...filter, ...pageWindow(filter), branchIds }),
      );
    });
  }

  device(actor: Principal, id: string): Promise<TelematicsDevice> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const device = await deps.telematics.device(id);
      if (device === null) throw new TelematicsNotFoundError("tracker");
      if (device.branchId === null) {
        if (deps.vehicleAccess.branchesFor(actor, "telematics.view") !== "all")
          throw new TelematicsNotFoundError("tracker");
      } else if (!deps.vehicleAccess.can(actor, "telematics.view", device.branchId))
        throw new TelematicsNotFoundError("tracker");
      return device;
    });
  }

  /** Adds a tracker before it first reports (or links one at once to its vehicle). */
  addDevice(
    actor: Principal,
    input: Readonly<{
      connectionId: string;
      identifier: string;
      label: string | null;
      vehicleId: string | null;
    }>,
  ): Promise<TelematicsDevice> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if ((await deps.telematics.connection(input.connectionId)) === null)
        throw new TelematicsNotFoundError("connection");
      const identifier = input.identifier.trim();
      const { rows: existing } = await deps.telematics.devices({
        branchIds: "all",
        connectionId: input.connectionId,
        limit: 5_000,
      });
      if (existing.some((d) => d.identifier === identifier))
        throw new TelematicsRuleError(`Tracker ${identifier} is already on this connection`);
      if (input.vehicleId !== null) await this.freeVehicle(actor, input.vehicleId, null);
      const id = await deps.telematics.createDevice({
        connectionId: input.connectionId,
        identifier,
        label: input.label?.trim() || null,
        vehicleId: input.vehicleId,
        createdBy: actor.userId,
      });
      await recordUserAction(deps, actor.userId, {
        action: "telematics.tracker_added",
        entityType: "telematics_device",
        entityId: id,
        after: { identifier, vehicleId: input.vehicleId },
      });
      return (await deps.telematics.device(id))!;
    });
  }

  updateDevice(actor: Principal, id: string, changes: DeviceChanges): Promise<TelematicsDevice> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const device = await deps.telematics.device(id);
      if (device === null) throw new TelematicsNotFoundError("tracker");
      if (device.status === "retired" && changes.status !== "active")
        throw new TelematicsRuleError("This tracker is retired; bring it back first");
      const vehicleChanges =
        changes.vehicleId !== undefined && changes.vehicleId !== device.vehicleId;
      if (vehicleChanges && changes.vehicleId !== null && changes.vehicleId !== undefined)
        await this.freeVehicle(actor, changes.vehicleId, id);
      if (changes.odometerOffsetKm !== undefined && Math.abs(changes.odometerOffsetKm) > 2_000_000)
        throw new TelematicsRuleError("The odometer offset is too large");
      const retiring = changes.status === "retired" && device.status !== "retired";
      if (vehicleChanges || retiring) await deps.telematics.resetTracking(id);
      await deps.telematics.updateDevice(id, {
        ...changes,
        ...(changes.label === undefined ? {} : { label: changes.label?.trim() || null }),
        // A retired tracker leaves its vehicle.
        ...(retiring ? { vehicleId: null } : {}),
      });
      await recordUserAction(deps, actor.userId, {
        action: retiring ? "telematics.tracker_retired" : "telematics.tracker_updated",
        entityType: "telematics_device",
        entityId: id,
        before: {
          vehicleId: device.vehicleId,
          status: device.status,
          syncOdometer: device.syncOdometer,
          odometerOffsetKm: device.odometerOffsetKm,
        },
        after: { ...changes },
      });
      return (await deps.telematics.device(id))!;
    });
  }

  /** The vehicle is within reach and has no other active tracker. */
  private async freeVehicle(actor: Principal, vehicleId: string, deviceId: string | null) {
    const { deps } = this;
    const vehicle = await deps.vehicleAccess.reach(actor, vehicleId, "telematics.manage");
    const other = await deps.telematics.vehicleDevice(vehicle.id);
    if (other !== null && other !== deviceId)
      throw new TelematicsRuleError("This vehicle already has a tracker; retire or move it first");
  }

  // --- geofences ---

  geofences(): Promise<GeofenceView[]> {
    return this.deps.unitOfWork.run(() => this.deps.telematics.geofences());
  }

  async geofence(id: string): Promise<GeofenceView> {
    const found = await this.deps.unitOfWork.run(() => this.deps.telematics.geofence(id));
    if (found === null) throw new TelematicsNotFoundError("geofence");
    return found;
  }

  saveGeofence(actor: Principal, id: string | null, input: GeofenceInputs): Promise<GeofenceView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = id === null ? null : await deps.telematics.geofence(id);
      if (id !== null && before === null) throw new TelematicsNotFoundError("geofence");
      const name = input.name.trim();
      if (await deps.telematics.geofenceNameTaken(name, id))
        throw new TelematicsRuleError(`A geofence called ${name} exists`);
      if (input.branchId !== null)
        await deps.vehicleAccess.branch(actor, "telematics.manage", input.branchId);
      const shape = checkGeofenceShape(input.shape);
      const geofenceId = id ?? deps.ids.next();
      await deps.telematics.saveGeofence(
        geofenceId,
        { ...input, name, shape },
        actor.userId,
        id === null,
      );
      await recordUserAction(deps, actor.userId, {
        action: id === null ? "telematics.geofence_created" : "telematics.geofence_updated",
        entityType: "geofence",
        entityId: geofenceId,
        ...(before === null
          ? {}
          : { before: { name: before.name, active: before.active, alertOn: before.alertOn } }),
        after: {
          name,
          kind: shape.kind,
          branchId: input.branchId,
          alertOn: input.alertOn,
          active: input.active,
        },
      });
      return (await deps.telematics.geofence(geofenceId))!;
    });
  }
}
