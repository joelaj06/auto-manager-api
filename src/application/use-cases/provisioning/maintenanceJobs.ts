import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { JobPayloads } from "../../jobs/jobCatalog.js";
import type { IClock } from "../../ports/IClock.js";
import type { IJobQueue } from "../../ports/IJobQueue.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IPermissionCatalogueSource } from "../../ports/IPermissionCatalogueSource.js";
import type { ITenantProvisioning } from "../../ports/ITenantProvisioning.js";
import type { ITenantSeeder } from "../../ports/ITenantSeeder.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";

const STALLED_AFTER_MS = 15 * 60_000;

/**
 * Safety net for provisioning: re-queues sagas that stopped making progress (lost job, crash) and
 * sweeps every cluster for tenant databases that belong to no tenant there and tenants whose
 * database is missing (decision 493). Orphans are only reported — never dropped.
 */
export class SweepProvisioning implements IJobHandler<"provisioning.sweep"> {
  readonly job = "provisioning.sweep" as const;

  constructor(
    private readonly deps: Readonly<{
      provisioning: ITenantProvisioning;
      /** The cluster sweep, recorded with its alerts (ClusterManagement). */
      clusters: Readonly<{ sweep(): Promise<unknown> }>;
      queue: IJobQueue;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  async handle(): Promise<void> {
    const { deps } = this;
    const stalled = await deps.provisioning.stalled(
      new Date(deps.clock.now().getTime() - STALLED_AFTER_MS),
    );
    for (const tenantId of stalled) {
      await deps.queue.enqueue("tenant.provision", { tenantId }, { singletonKey: tenantId });
    }
    if (stalled.length > 0)
      deps.logger.warn("Re-queued stalled provisioning", { tenants: stalled });

    await deps.clusters.sweep();
  }
}

/** Enqueues a catalogue sync for every tenant behind the current catalogue version. */
export class SweepCatalogue implements IJobHandler<"catalogue.sweep"> {
  readonly job = "catalogue.sweep" as const;

  constructor(
    private readonly deps: Readonly<{
      provisioning: ITenantProvisioning;
      catalogue: IPermissionCatalogueSource;
      queue: IJobQueue;
    }>,
  ) {}

  async handle(): Promise<void> {
    const { version } = await this.deps.catalogue.current();
    for (const tenantId of await this.deps.provisioning.behindCatalogue(version)) {
      await this.deps.queue.enqueue(
        "tenant.catalogue_sync",
        { tenantId, version },
        { singletonKey: tenantId },
      );
    }
  }
}

/**
 * Brings one tenant to the current catalogue (docs/28 §5): new permissions added, removed ones
 * deprecated, system roles matched to templates, custom roles untouched, holders of changed roles
 * get new tokens.
 */
export class SyncTenantCatalogue implements IJobHandler<"tenant.catalogue_sync"> {
  readonly job = "tenant.catalogue_sync" as const;

  constructor(
    private readonly deps: Readonly<{
      catalogue: IPermissionCatalogueSource;
      unitOfWork: IUnitOfWork;
      seeder: ITenantSeeder;
      provisioning: ITenantProvisioning;
      logger: ILogger;
    }>,
  ) {}

  async handle({ tenantId }: JobPayloads["tenant.catalogue_sync"]): Promise<void> {
    const { deps } = this;
    const catalogue = await deps.catalogue.current();
    const result = await deps.unitOfWork.run(() => deps.seeder.syncCatalogue(catalogue));
    await deps.provisioning.setCatalogueVersion(tenantId, catalogue.version);
    deps.logger.info("Tenant catalogue synced", {
      tenantId,
      version: catalogue.version,
      ...result,
    });
  }
}
