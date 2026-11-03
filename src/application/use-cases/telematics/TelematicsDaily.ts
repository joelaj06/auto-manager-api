import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import type { ITenantDailyTask } from "../../jobs/ITenantDailyTask.js";
import type { IClock } from "../../ports/IClock.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { INotificationSettingsStore } from "../../ports/INotifications.js";
import type { ITelematics } from "../../ports/ITelematics.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { Notifier } from "../notifications/Notifier.js";
import type { OdometerLog } from "../vehicles/OdometerLog.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const PURGE_BATCH = 20_000;
const MAX_PURGE_BATCHES = 50;

/**
 * The daily telematics run (decision 507): positions older than the days kept are deleted in
 * batches (trips, daily totals and events stay), trips left open by a tracker gone quiet end at
 * their last position, trackers silent longer than the hours set are told to the branch once per
 * silence, and each tracker's odometer is recorded on its vehicle when it moved on at least a
 * kilometre (source telematics; a reading the vehicle's history refuses is skipped).
 */
export class TelematicsDaily implements ITenantDailyTask {
  readonly name = "telematics";

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      telematics: ITelematics;
      vehicles: IVehicleRepository;
      odometer: OdometerLog;
      notificationSettings: INotificationSettingsStore;
      notifier: Notifier;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  async run(_localDate: string): Promise<void> {
    const { deps } = this;
    const now = deps.clock.now();
    const settings = await deps.unitOfWork.run(() => deps.telematics.settings());

    // Each batch is its own transaction: a large purge never holds one open for long.
    const before = new Date(now.getTime() - settings.positionRetentionDays * DAY_MS);
    let purged = 0;
    for (let i = 0; i < MAX_PURGE_BATCHES; i++) {
      const deleted = await deps.unitOfWork.run(() =>
        deps.telematics.purgePositions(before, PURGE_BATCH),
      );
      purged += deleted;
      if (deleted < PURGE_BATCH) break;
    }

    await deps.unitOfWork.run(async () => {
      const closed = await deps.telematics.closeStaleTrips(new Date(now.getTime() - HOUR_MS));
      const notifications = await deps.notificationSettings.get();
      const silentBefore = new Date(now.getTime() - settings.silentAfterHours * HOUR_MS);
      for (const s of await deps.telematics.silentDevices(silentBefore)) {
        const hoursSilent = Math.floor((now.getTime() - s.lastReceivedAt.getTime()) / HOUR_MS);
        await deps.notifier.staff(notifications, {
          rule: "telematics_silent",
          permission: "telematics.view",
          branchId: s.vehicle.branchId,
          dedupeKey: `telematics_silent:${s.deviceId}:${s.lastReceivedAt.toISOString()}`,
          title: `No position from ${s.vehicle.name} for ${hoursSilent} hours`,
          body: `The tracker on ${s.vehicle.name} has sent nothing for ${hoursSilent} hours. Check that it has power and signal.`,
          severity: "warning",
          data: { vehicleId: s.vehicle.vehicleId, deviceId: s.deviceId },
        });
        await deps.telematics.markSilentNotified(s.deviceId, now);
      }
      if (purged > 0 || closed > 0)
        deps.logger.info("Telematics housekeeping", {
          positionsPurged: purged,
          tripsClosed: closed,
        });
    });

    for (const reading of await deps.unitOfWork.run(() => deps.telematics.odometerReadings())) {
      try {
        await deps.unitOfWork.run(async () => {
          const vehicle = await deps.vehicles.lockById(reading.vehicleId);
          if (vehicle === null || vehicle.deleted) return;
          const value = Math.round(reading.odometerKm);
          const current = vehicle.snapshot().currentOdometer;
          if (current !== null && value < current + 1) return;
          await deps.odometer.recordFor(
            vehicle,
            { value, readAt: reading.at },
            "telematics",
            reading.deviceId,
            null,
          );
        });
      } catch (error) {
        deps.logger.warn("Telematics odometer not recorded", {
          vehicleId: reading.vehicleId,
          error,
        });
      }
    }
  }
}
