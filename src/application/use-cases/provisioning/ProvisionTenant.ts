import { createHash, randomBytes } from "node:crypto";
import { TenantId } from "../../../domain/value-objects/TenantId.js";
import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { JobPayloads } from "../../jobs/jobCatalog.js";
import type { NotificationService } from "../../notifications/NotificationService.js";
import type { IClock } from "../../ports/IClock.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IPermissionCatalogueSource } from "../../ports/IPermissionCatalogueSource.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { ITenantDatabaseProvisioner } from "../../ports/ITenantDatabaseProvisioner.js";
import {
  PROVISIONING_STEPS,
  type ITenantProvisioning,
  type ProvisioningStep,
} from "../../ports/ITenantProvisioning.js";
import type { ITenantSchemaUpdater } from "../../ports/ITenantSchemaUpdater.js";
import type { ITenantSeeder } from "../../ports/ITenantSeeder.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { IUserDirectory } from "../../ports/IUserDirectory.js";
import type { IUserInvitations } from "../../ports/IUserInvitations.js";

export type ProvisioningSettings = Readonly<{
  webAppUrl: string;
  ownerInvitationTtlMs: number;
  defaultBranch: Readonly<{ code: string; name: string }>;
}>;

const DAY_MS = 86_400_000;

/**
 * The provisioning saga (docs/22 §2.6), run by the `tenant.provision` job:
 *
 *   registered → database_created → schema_migrated → seeded → directory_updated → welcomed → completed
 *
 * Each step is idempotent and its completion is recorded, so a failed run resumes where it
 * stopped (pg-boss retries; staff can retry from the console). On failure the tenant is
 * `provisioning_failed` with the error; nothing is ever dropped automatically (decision 36).
 * At the end the tenant is `trialing` and the owner has an email to set their password.
 */
export class ProvisionTenant implements IJobHandler<"tenant.provision"> {
  readonly job = "tenant.provision" as const;

  constructor(
    private readonly deps: Readonly<{
      provisioning: ITenantProvisioning;
      databases: ITenantDatabaseProvisioner;
      schema: ITenantSchemaUpdater;
      catalogue: IPermissionCatalogueSource;
      tenantContext: ITenantContext;
      unitOfWork: IUnitOfWork;
      seeder: ITenantSeeder;
      invitations: IUserInvitations;
      directory: IUserDirectory;
      notifications: NotificationService;
      audit: IPlatformAuditTrail;
      clock: IClock;
      logger: ILogger;
      settings: ProvisioningSettings;
    }>,
  ) {}

  async handle({ tenantId }: JobPayloads["tenant.provision"]): Promise<void> {
    const { deps } = this;
    const record = await deps.provisioning.find(tenantId);
    if (record === null) {
      deps.logger.warn("Provisioning requested for an unknown tenant", { tenantId });
      return;
    }
    if (record.status === "completed") return;

    await deps.provisioning.begin(tenantId);
    let step: ProvisioningStep = record.step;
    const done = (s: ProvisioningStep) =>
      PROVISIONING_STEPS.indexOf(step) >= PROVISIONING_STEPS.indexOf(s);
    const id = TenantId.from(tenantId);
    const inTenant = <T>(work: () => Promise<T>) =>
      deps.tenantContext.runAs(id, () => deps.unitOfWork.run(work));
    const advance = async (next: ProvisioningStep) => {
      await deps.provisioning.advance(tenantId, next);
      step = next;
    };

    try {
      if (!done("database_created")) {
        const { databaseName } = await deps.databases.provision(id);
        await deps.provisioning.setDatabaseName(tenantId, databaseName);
        await advance("database_created");
      }
      if (!done("schema_migrated")) {
        await deps.schema.migrate(tenantId);
        await advance("schema_migrated");
      }
      const catalogue = await deps.catalogue.current();
      if (!done("seeded")) {
        const { application: app } = record;
        await inTenant(() =>
          deps.seeder.seed({
            organisation: {
              name: record.name,
              country: app.country,
              timezone: record.timezone,
              tin: app.tin,
              registrationNumber: app.registrationNumber,
              contactEmail: app.contactEmail,
              contactPhone: app.contactPhone,
            },
            owner: { name: app.contactName, email: app.contactEmail, phone: app.contactPhone },
            defaultBranch: deps.settings.defaultBranch,
            catalogue,
          }),
        );
        await advance("seeded");
      }
      const owner = await inTenant(() => deps.seeder.owner());
      if (owner === null) throw new Error("Seeded tenant has no owner");
      if (!done("directory_updated")) {
        await deps.directory.upsert({
          tenantId,
          tenantUserId: owner.id,
          email: owner.email,
          phone: owner.phone,
          status: "active",
        });
        await advance("directory_updated");
      }
      if (!done("welcomed")) {
        const token = randomBytes(32).toString("base64url");
        const tokenHash = createHash("sha256").update(token).digest("hex");
        const invitationId = await inTenant(() =>
          deps.invitations.create({
            userId: owner.id,
            tokenHash,
            expiresAt: new Date(deps.clock.now().getTime() + deps.settings.ownerInvitationTtlMs),
          }),
        );
        await deps.notifications.sendEmail({
          to: record.application.contactEmail,
          template: "tenant.welcome_owner",
          data: {
            ownerName: owner.name,
            businessName: record.name,
            slug: record.slug,
            setPasswordUrl: `${deps.settings.webAppUrl.replace(/\/$/, "")}/${record.slug}/accept-invitation#token=${token}`,
            expiresInHours: Math.round(deps.settings.ownerInvitationTtlMs / 3_600_000),
            trialDays: record.application.trialDays,
          },
          idempotencyKey: `tenant-welcome:${tenantId}:${invitationId}`,
          tenantId,
        });
        await advance("welcomed");
      }
      await deps.provisioning.complete(tenantId, {
        trialEndsAt: new Date(deps.clock.now().getTime() + record.application.trialDays * DAY_MS),
        catalogueVersion: catalogue.version,
      });
      await deps.audit.record({
        actorType: "system",
        action: "tenant.provisioned",
        entityType: "tenant",
        entityId: tenantId,
        targetTenantId: tenantId,
        after: { slug: record.slug, catalogueVersion: catalogue.version },
      });
      deps.logger.info("Tenant provisioned", { tenantId, slug: record.slug });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.provisioning.fail(tenantId, `${step}: ${message}`.slice(0, 2_000));
      await deps.audit
        .record({
          actorType: "system",
          action: "tenant.provisioning_failed",
          entityType: "tenant",
          entityId: tenantId,
          targetTenantId: tenantId,
          after: { step, error: message.slice(0, 500) },
        })
        .catch(() => undefined);
      throw error;
    }
  }
}
