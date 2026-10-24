import type {
  DataExport,
  ITenantDataExportRepository,
} from "../../../domain/repositories/ITenantDataExportRepository.js";
import { TenantId } from "../../../domain/value-objects/TenantId.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { NotificationService } from "../../notifications/NotificationService.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IJobQueue } from "../../ports/IJobQueue.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IObjectStorage } from "../../ports/IObjectStorage.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { ITenantDataArchiver } from "../../ports/ITenantDataArchiver.js";
import type { ITenantDirectory } from "../../ports/ITenantDirectory.js";
import type { ITenantSeeder } from "../../ports/ITenantSeeder.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { recordStaffAction } from "./consoleAudit.js";

export class DataExportNotFoundError extends ApplicationError {
  readonly code = "DATA_EXPORT_NOT_FOUND";
  constructor() {
    super("Data export not found");
  }
}

export class DataExportStateError extends ApplicationError {
  constructor(
    readonly code: "DATA_EXPORT_RUNNING" | "DATA_EXPORT_NOT_READY",
    message: string,
  ) {
    super(message);
  }
}

const DAY_MS = 86_400_000;
/** The archive is kept, and downloadable, this long (docs/26 §6). */
const KEEP_DAYS = 7;
const LINK_SECONDS = 300;

/**
 * "Export all my data" (docs/26 §6): the owner — or staff for them, the exit path — asks; a job
 * builds the archive (CSV per table, the files, a README), keeps it privately for 7 days and
 * emails the owner that it is ready. Downloading needs signing in and gives a short-lived link;
 * every request and download is audited, and the archive is removed when it expires.
 */
export class TenantDataExports implements IJobHandler<"tenant.data_export"> {
  readonly job = "tenant.data_export" as const;

  constructor(
    private readonly deps: Readonly<{
      exports: ITenantDataExportRepository;
      archiver: ITenantDataArchiver;
      storage: IObjectStorage;
      queue: IJobQueue;
      directory: ITenantDirectory;
      tenantContext: ITenantContext;
      tenantUnitOfWork: IUnitOfWork;
      seeder: ITenantSeeder;
      tenantAudit: IAuditTrail;
      email: NotificationService;
      unitOfWork: IPlatformUnitOfWork;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
      logger: ILogger;
      exportsUrl: string;
    }>,
  ) {}

  /** The owner asks (tenant app). */
  async request(tenantId: string, userId: string): Promise<DataExport> {
    const e = await this.start(tenantId, { type: "user", id: userId });
    await this.inTenant(tenantId, () =>
      this.tenantAudit("data.export_requested", e.id, { type: "user", id: userId }),
    );
    return e;
  }

  /** Staff ask for the owner (cancelling tenants, support). */
  async requestForTenant(
    tenantId: string,
    reason: string,
    actor: PlatformPrincipal,
  ): Promise<DataExport> {
    if ((await this.deps.directory.findById(tenantId)) === null)
      throw new DataExportNotFoundError();
    const e = await this.start(tenantId, { type: "platform_staff", id: actor.userId });
    await this.deps.unitOfWork.run(() =>
      recordStaffAction(this.deps, actor, {
        action: "data.export_requested",
        entityType: "tenant_data_export",
        entityId: e.id,
        targetTenantId: tenantId,
        reason,
      }),
    );
    return e;
  }

  list(tenantId: string): Promise<DataExport[]> {
    return this.deps.exports.list(tenantId, 20);
  }

  /** A short-lived link to the archive (audited, counted). */
  async download(
    tenantId: string,
    id: string,
    userId: string,
  ): Promise<Readonly<{ url: string; expiresAt: Date }>> {
    const { deps } = this;
    const now = deps.clock.now();
    const e = await deps.unitOfWork.run(async () => {
      const found = await deps.exports.find(id, true);
      if (found === null || found.tenantId !== tenantId) throw new DataExportNotFoundError();
      if (found.status !== "ready" || found.storageKey === null)
        throw new DataExportStateError(
          "DATA_EXPORT_NOT_READY",
          "This export is not ready, or has expired",
        );
      const counted: DataExport = {
        ...found,
        downloads: found.downloads + 1,
        lastDownloadedAt: now,
      };
      await deps.exports.save(counted);
      return counted;
    });
    await this.inTenant(tenantId, () =>
      this.tenantAudit("data.export_downloaded", id, { type: "user", id: userId }),
    );
    const url = await deps.storage.presignDownload({
      key: e.storageKey!,
      filename: `autoforce-export-${e.requestedAt.toISOString().slice(0, 10)}.zip`,
      contentType: "application/zip",
      expiresInSeconds: LINK_SECONDS,
    });
    return { url, expiresAt: new Date(now.getTime() + LINK_SECONDS * 1000) };
  }

  /** The job: build, store, tell the owner. */
  async handle({ exportId }: Readonly<{ exportId: string }>): Promise<void> {
    const { deps } = this;
    const e = await deps.exports.find(exportId);
    if (e === null || (e.status !== "queued" && e.status !== "running")) return;
    await deps.exports.save({ ...e, status: "running" });
    try {
      const owner = await this.inTenant(e.tenantId, () => deps.seeder.owner());
      const tenant = await deps.directory.findById(e.tenantId);
      const now = deps.clock.now();
      const built = await deps.archiver.build(e.tenantId, {
        businessName: tenant?.slug ?? e.tenantId,
        generatedAt: now,
      });
      const key = `exports/${e.tenantId}/${e.id}.zip`;
      await deps.storage.put("private", key, built.zip, "application/zip");
      const expiresAt = new Date(now.getTime() + KEEP_DAYS * DAY_MS);
      await deps.exports.save({
        ...e,
        status: "ready",
        storageKey: key,
        sizeBytes: built.zip.byteLength,
        tables: built.tables,
        filesIncluded: built.filesIncluded,
        filesSkipped: built.filesSkipped,
        completedAt: deps.clock.now(),
        expiresAt,
      });
      if (owner !== null && owner.email !== null)
        await deps.email.sendEmail({
          to: owner.email,
          template: "tenant.data_export_ready",
          data: {
            name: owner.name,
            url: deps.exportsUrl,
            expiresOn: expiresAt.toISOString().slice(0, 10),
          },
          idempotencyKey: `data-export:${e.id}`,
          tenantId: e.tenantId,
        });
    } catch (error) {
      deps.logger.error("Tenant data export failed", { exportId, error });
      await deps.exports.save({
        ...e,
        status: "failed",
        error: error instanceof Error ? error.message : "Failed",
        completedAt: deps.clock.now(),
      });
      throw error;
    }
  }

  /** Removes expired archives (the daily compliance job). */
  async expire(): Promise<number> {
    const { deps } = this;
    let removed = 0;
    for (const e of await deps.exports.expiredBy(deps.clock.now())) {
      if (e.storageKey !== null) await deps.storage.remove("private", e.storageKey);
      await deps.exports.save({ ...e, status: "expired", storageKey: null });
      removed += 1;
    }
    return removed;
  }

  private async start(
    tenantId: string,
    by: Readonly<{ type: "user" | "platform_staff"; id: string }>,
  ): Promise<DataExport> {
    const { deps } = this;
    const running = await deps.exports.inProgress(tenantId);
    if (running !== null)
      throw new DataExportStateError("DATA_EXPORT_RUNNING", "An export is already being prepared");
    const e: DataExport = {
      id: deps.ids.next(),
      tenantId,
      requestedByType: by.type,
      requestedBy: by.id,
      status: "queued",
      storageKey: null,
      sizeBytes: null,
      tables: null,
      filesIncluded: null,
      filesSkipped: null,
      error: null,
      requestedAt: deps.clock.now(),
      completedAt: null,
      expiresAt: null,
      downloads: 0,
      lastDownloadedAt: null,
    };
    await deps.exports.save(e);
    await deps.queue.enqueue("tenant.data_export", { exportId: e.id });
    return e;
  }

  private inTenant<T>(tenantId: string, body: () => Promise<T>): Promise<T> {
    return this.deps.tenantContext.runAs(TenantId.from(tenantId), () =>
      this.deps.tenantUnitOfWork.run(body),
    );
  }

  private async tenantAudit(
    action: string,
    exportId: string,
    by: Readonly<{ type: "user" | "platform_staff"; id: string }>,
  ): Promise<void> {
    const request = this.deps.requestContext.current();
    await this.deps.tenantAudit.record({
      actorType: by.type,
      actorId: by.id,
      action,
      entityType: "data_export",
      entityId: exportId,
      requestId: request?.requestId ?? null,
      ip: request?.ip ?? null,
    });
  }
}
