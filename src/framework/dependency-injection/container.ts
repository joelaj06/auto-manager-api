import { billingRoutes } from "../../adapters/routes/billingRoutes.js";
import { BranchEntitlements } from "../../application/use-cases/billing/BranchEntitlements.js";
import { ManualBilling } from "../../application/use-cases/billing/ManualBilling.js";
import { SubscriptionAdministration } from "../../application/use-cases/billing/SubscriptionAdministration.js";
import { TenantBilling } from "../../application/use-cases/billing/TenantBilling.js";
import type { IBillingRepository } from "../../domain/repositories/IBillingRepository.js";
import { PostgresBillingRepository } from "../../infrastructure/billing/PostgresBillingRepository.js";
import { mobileRoutes } from "../../adapters/routes/mobileRoutes.js";
import type { IConnectLinkSigner } from "../../application/ports/IConnectLinkSigner.js";
import { MobileConnect } from "../../application/use-cases/mobile/MobileConnect.js";
import { HostAllowList } from "../../domain/mobile/ConnectLink.js";
import {
  DEVELOPMENT_KEY_SEED,
  Ed25519ConnectLinkSigner,
} from "../../infrastructure/mobile/Ed25519ConnectLinkSigner.js";
import { QrcodeSvgRenderer } from "../../infrastructure/mobile/QrcodeSvgRenderer.js";
import { fileRoutes } from "../../adapters/routes/fileRoutes.js";
import type { IObjectStorage } from "../../application/ports/IObjectStorage.js";
import {
  APPLICATION_OWNER,
  ApplicationDocuments,
  MAX_APPLICATION_DOCUMENTS,
} from "../../application/use-cases/applications/ApplicationDocuments.js";
import { FileService } from "../../application/use-cases/files/FileService.js";
import { OwnedDocuments } from "../../application/use-cases/files/OwnedDocuments.js";
import { SweepAbandonedFiles } from "../../application/use-cases/files/SweepAbandonedFiles.js";
import { TenantFileUploads } from "../../application/use-cases/files/TenantFileUploads.js";
import {
  MAX_PARTNER_DOCUMENTS,
  PARTNER_OWNER,
  PartnerDocuments,
} from "../../application/use-cases/partners/PartnerDocuments.js";
import type { IFileRepository } from "../../domain/repositories/IFileRepository.js";
import { PostgresFileRepository } from "../../infrastructure/storage/PostgresFileRepository.js";
import { S3ObjectStorage } from "../../infrastructure/storage/S3ObjectStorage.js";
import { partnerRoutes } from "../../adapters/routes/partnerRoutes.js";
import type {
  IPartnerAttributions,
  IPartnerQueries,
} from "../../application/ports/IPartnerQueries.js";
import { PartnerAdministration } from "../../application/use-cases/partners/PartnerAdministration.js";
import { PartnerPortal } from "../../application/use-cases/partners/PartnerPortal.js";
import type { IPartnerRepository } from "../../domain/repositories/IPartnerRepository.js";
import { PostgresPartnerRepository } from "../../infrastructure/partners/PostgresPartnerRepository.js";
import {
  PostgresPartnerAttributions,
  PostgresPartnerQueries,
} from "../../infrastructure/partners/PostgresPartnerQueries.js";
import { consoleRoutes } from "../../adapters/routes/consoleRoutes.js";
import type { IConsoleTenantQueries } from "../../application/ports/IConsoleTenantQueries.js";
import type { IDataOperationsQueries } from "../../application/ports/IDataOperationsQueries.js";
import type { ISystemProbes } from "../../application/ports/ISystemProbes.js";
import type { ITenantNotes, ITenantTags } from "../../application/ports/ITenantNotes.js";
import type { ITenantUsage } from "../../application/ports/ITenantUsage.js";
import { AuditLogExport } from "../../application/use-cases/console/AuditLogExport.js";
import { ConsoleDashboard } from "../../application/use-cases/console/ConsoleDashboard.js";
import { DataOperationsConsole } from "../../application/use-cases/console/DataOperationsConsole.js";
import { SystemHealthSummary } from "../../application/use-cases/console/SystemHealthSummary.js";
import { TenantAccounts } from "../../application/use-cases/console/TenantAccounts.js";
import { TenantNotesAndTags } from "../../application/use-cases/console/TenantNotesAndTags.js";
import { PostgresConsoleTenantQueries } from "../../infrastructure/console/PostgresConsoleTenantQueries.js";
import { PostgresDataOperationsQueries } from "../../infrastructure/console/PostgresDataOperationsQueries.js";
import { PostgresSystemProbes } from "../../infrastructure/console/PostgresSystemProbes.js";
import {
  PostgresTenantNotes,
  PostgresTenantTags,
} from "../../infrastructure/console/PostgresTenantNotes.js";
import { PostgresTenantUsage } from "../../infrastructure/console/PostgresTenantUsage.js";
import { readFileSync } from "node:fs";
import type { Express } from "express";
import { Container } from "inversify";
import type pg from "pg";
import { HealthController } from "../../adapters/controllers/HealthController.js";
import type { ApiRoute } from "../../adapters/routes/ApiRoute.js";
import { healthRoutes } from "../../adapters/routes/healthRoutes.js";
import { openApiRoutes } from "../../adapters/routes/openApiRoutes.js";
import { sessionRoutes } from "../../adapters/routes/sessionRoutes.js";
import type { ILogger } from "../../application/ports/ILogger.js";
import type { IReadinessCheck } from "../../application/ports/IReadinessCheck.js";
import type { IRequestContext } from "../../application/ports/IRequestContext.js";
import type { IAuditTrail } from "../../application/ports/IAuditTrail.js";
import type { IOutbox } from "../../application/ports/IOutbox.js";
import type { ISequenceGenerator } from "../../application/ports/ISequenceGenerator.js";
import type { ITenantContext } from "../../application/ports/ITenantContext.js";
import type { ITenantDatabaseProvisioner } from "../../application/ports/ITenantDatabaseProvisioner.js";
import type { IUnitOfWork } from "../../application/ports/IUnitOfWork.js";
import { ReadinessService } from "../../application/services/ReadinessService.js";
import type { AppConfig } from "../../infrastructure/config/config.js";
import { AsyncLocalRequestContext } from "../../infrastructure/context/AsyncLocalRequestContext.js";
import { AsyncLocalTenantContext } from "../../infrastructure/context/AsyncLocalTenantContext.js";
import { DatabaseReadinessCheck } from "../../infrastructure/database/DatabaseReadinessCheck.js";
import type { MigrationSets } from "../../infrastructure/database/migrations/MigrationCatalog.js";
import { MigrationRunner } from "../../infrastructure/database/migrations/MigrationRunner.js";
import { PostgresConnectionFactory } from "../../infrastructure/database/postgres/PostgresConnectionFactory.js";
import { PostgresTransactionContext } from "../../infrastructure/database/postgres/PostgresTransactionContext.js";
import { TenantConnectionPools } from "../../infrastructure/database/postgres/TenantConnectionPools.js";
import { TenantDatabaseNaming } from "../../infrastructure/database/postgres/TenantDatabaseNaming.js";
import { PostgresTenantUnitOfWork } from "../../infrastructure/database/PostgresTenantUnitOfWork.js";
import { TenantDatabaseProvisioner } from "../../infrastructure/database/provisioning/TenantDatabaseProvisioner.js";
import { PostgresAuditTrail } from "../../infrastructure/database/repositories/PostgresAuditTrail.js";
import { PostgresOutbox } from "../../infrastructure/database/repositories/PostgresOutbox.js";
import { PostgresSequenceGenerator } from "../../infrastructure/database/repositories/PostgresSequenceGenerator.js";
import { AccessGuard } from "../../adapters/middleware/AccessGuard.js";
import { AuthorizationPolicy } from "../../application/authorization/AuthorizationPolicy.js";
import type { IAccessTokenService } from "../../application/ports/IAccessTokenService.js";
import type { IClock } from "../../application/ports/IClock.js";
import type { IIdGenerator } from "../../application/ports/IIdGenerator.js";
import type { IOtpService } from "../../application/ports/IOtpService.js";
import type { IPasswordHasher } from "../../application/ports/IPasswordHasher.js";
import type { IPermissionResolver } from "../../application/ports/IPermissionResolver.js";
import type { IRefreshTokenService } from "../../application/ports/IRefreshTokenService.js";
import type { ITenantDirectory } from "../../application/ports/ITenantDirectory.js";
import { AuthenticateTenantRequest } from "../../application/use-cases/auth/AuthenticateTenantRequest.js";
import { IssueOtpChallenge } from "../../application/use-cases/auth/IssueOtpChallenge.js";
import { RefreshAuthSession } from "../../application/use-cases/auth/RefreshAuthSession.js";
import { ResolveTenant } from "../../application/use-cases/auth/ResolveTenant.js";
import { RevokeAuthSession } from "../../application/use-cases/auth/RevokeAuthSession.js";
import { StartAuthSession } from "../../application/use-cases/auth/StartAuthSession.js";
import { VerifyOtpChallenge } from "../../application/use-cases/auth/VerifyOtpChallenge.js";
import type { IAuthSessionRepository } from "../../domain/repositories/IAuthSessionRepository.js";
import type { IOtpChallengeRepository } from "../../domain/repositories/IOtpChallengeRepository.js";
import { CachingPermissionResolver } from "../../infrastructure/authorization/CachingPermissionResolver.js";
import { PostgresTenantPermissionResolver } from "../../infrastructure/authorization/PostgresTenantPermissionResolver.js";
import { provisioningRoutes } from "../../adapters/routes/provisioningRoutes.js";
import { lifecycleRoutes } from "../../adapters/routes/lifecycleRoutes.js";
import { identityRoutes } from "../../adapters/routes/identityRoutes.js";
import { EscalationGuard } from "../../application/authorization/EscalationGuard.js";
import type { IOrganisationSettings } from "../../application/ports/IOrganisationSettings.js";
import type { ITenantRoles } from "../../application/ports/ITenantRoles.js";
import type { ITenantSessions } from "../../application/ports/ITenantSessions.js";
import type { IUserMemberships } from "../../application/ports/IUserMemberships.js";
import { OrganisationAdministration } from "../../application/use-cases/identity/OrganisationAdministration.js";
import { RoleAdministration } from "../../application/use-cases/identity/RoleAdministration.js";
import { SessionManagement } from "../../application/use-cases/identity/SessionManagement.js";
import { TenantSignIn } from "../../application/use-cases/identity/TenantSignIn.js";
import { UserAdministration } from "../../application/use-cases/identity/UserAdministration.js";
import type { ITenantUserRepository } from "../../domain/repositories/ITenantUserRepository.js";
import { PostgresOrganisationSettings } from "../../infrastructure/identity/PostgresOrganisationSettings.js";
import { PostgresTenantRoles } from "../../infrastructure/identity/PostgresTenantRoles.js";
import { PostgresTenantSessions } from "../../infrastructure/identity/PostgresTenantSessions.js";
import { PostgresTenantUserRepository } from "../../infrastructure/identity/PostgresTenantUserRepository.js";
import { PostgresUserMemberships } from "../../infrastructure/identity/PostgresUserMemberships.js";
import type { IBranchDeactivationCheck, IBranches } from "../../application/ports/IBranches.js";
import type {
  IOrganisationReader,
  ITenantPublicProfiles,
} from "../../application/ports/ITenantPublicProfiles.js";
import type { ITenantSessionRevoker } from "../../application/ports/ITenantSessionRevoker.js";
import type { IPermissionCache } from "../../application/ports/IPermissionCache.js";
import { BranchLifecycle } from "../../application/use-cases/tenants/BranchLifecycle.js";
import { TenantLifecycleService } from "../../application/use-cases/tenants/TenantLifecycleService.js";
import { TenantPublicConfig } from "../../application/use-cases/tenants/TenantPublicConfig.js";
import type { ITenantLifecycleRepository } from "../../domain/repositories/ITenantLifecycleRepository.js";
import { PostgresTenantLifecycleRepository } from "../../infrastructure/tenants/PostgresTenantLifecycleRepository.js";
import {
  PostgresBranches,
  PostgresOrganisationReader,
  PostgresTenantSessionRevoker,
} from "../../infrastructure/tenants/PostgresTenantOrganisation.js";
import { PostgresTenantPublicProfiles } from "../../infrastructure/tenants/PostgresTenantPublicProfiles.js";
import type { IOrphanDatabases } from "../../application/ports/IOrphanDatabases.js";
import type { IPermissionCatalogueSource } from "../../application/ports/IPermissionCatalogueSource.js";
import type { ITenantProvisioning } from "../../application/ports/ITenantProvisioning.js";
import type { ITenantSchemaUpdater } from "../../application/ports/ITenantSchemaUpdater.js";
import type { ITenantSeeder } from "../../application/ports/ITenantSeeder.js";
import type { ITenantUserAccounts } from "../../application/ports/ITenantUserAccounts.js";
import type { IUserDirectory } from "../../application/ports/IUserDirectory.js";
import type { IUserInvitations } from "../../application/ports/IUserInvitations.js";
import { AcceptUserInvitation } from "../../application/use-cases/auth/AcceptUserInvitation.js";
import {
  SweepCatalogue,
  SweepProvisioning,
  SyncTenantCatalogue,
} from "../../application/use-cases/provisioning/maintenanceJobs.js";
import { ProvisioningConsole } from "../../application/use-cases/provisioning/ProvisioningConsole.js";
import { ProvisionTenant } from "../../application/use-cases/provisioning/ProvisionTenant.js";
import { HmacUserDirectory } from "../../infrastructure/provisioning/HmacUserDirectory.js";
import { MigratorTenantSchemaUpdater } from "../../infrastructure/provisioning/MigratorTenantSchemaUpdater.js";
import { PostgresOrphanDatabases } from "../../infrastructure/provisioning/PostgresOrphanDatabases.js";
import { PostgresPermissionCatalogueSource } from "../../infrastructure/provisioning/PostgresPermissionCatalogueSource.js";
import { PostgresTenantProvisioning } from "../../infrastructure/provisioning/PostgresTenantProvisioning.js";
import { PostgresTenantSeeder } from "../../infrastructure/provisioning/PostgresTenantSeeder.js";
import {
  PostgresTenantUserAccounts,
  PostgresUserInvitations,
} from "../../infrastructure/provisioning/PostgresTenantUsers.js";
import { PostgresAuthSessionRepository } from "../../infrastructure/database/repositories/PostgresAuthSessionRepository.js";
import { PostgresOtpChallengeRepository } from "../../infrastructure/database/repositories/PostgresOtpChallengeRepository.js";
import { PostgresTenantDirectory } from "../../infrastructure/database/repositories/PostgresTenantDirectory.js";
import { UuidV7Generator } from "../../infrastructure/ids/UuidV7Generator.js";
import { Argon2PasswordHasher } from "../../infrastructure/security/Argon2PasswordHasher.js";
import { CryptoRefreshTokenService } from "../../infrastructure/security/CryptoRefreshTokenService.js";
import { HmacOtpService } from "../../infrastructure/security/HmacOtpService.js";
import { JwtAccessTokenService } from "../../infrastructure/security/JwtAccessTokenService.js";
import { SystemClock } from "../../infrastructure/time/SystemClock.js";
import { PgBoss } from "pg-boss";
import { EventHandlerRegistry } from "../../application/events/EventHandlerRegistry.js";
import type { IEventHandler } from "../../application/events/IEventHandler.js";
import type { IJobHandler } from "../../application/jobs/IJobHandler.js";
import { NotificationService } from "../../application/notifications/NotificationService.js";
import type { IEmailDeliveries } from "../../application/ports/IEmailDeliveries.js";
import type { IEmailSender } from "../../application/ports/IEmailSender.js";
import type { IJobQueue } from "../../application/ports/IJobQueue.js";
import type { IOutboxStore } from "../../application/ports/IOutboxStore.js";
import type { IProcessedMessages } from "../../application/ports/IProcessedMessages.js";
import type { ITenantRetention } from "../../application/ports/ITenantRetention.js";
import type { ITenantRoster } from "../../application/ports/ITenantRoster.js";
import type { ITenantScheduleLedger } from "../../application/ports/ITenantScheduleLedger.js";
import { DeliverEvent } from "../../application/use-cases/jobs/DeliverEvent.js";
import { DrainOutbox } from "../../application/use-cases/jobs/DrainOutbox.js";
import { RunDailyMaintenance } from "../../application/use-cases/jobs/RunDailyMaintenance.js";
import { RunTenantSchedules } from "../../application/use-cases/jobs/RunTenantSchedules.js";
import { SendQueuedEmail } from "../../application/use-cases/jobs/SendQueuedEmail.js";
import { SweepOutboxes } from "../../application/use-cases/jobs/SweepOutboxes.js";
import { PostgresOutboxStore } from "../../infrastructure/database/repositories/PostgresOutboxStore.js";
import { PostgresProcessedMessages } from "../../infrastructure/database/repositories/PostgresProcessedMessages.js";
import { PostgresTenantRetention } from "../../infrastructure/database/repositories/PostgresTenantRetention.js";
import { PostgresTenantRoster } from "../../infrastructure/database/repositories/PostgresTenantRoster.js";
import {
  PgBossJobQueue,
  pgBossOptions,
  type JobQueueMode,
} from "../../infrastructure/jobs/PgBossJobQueue.js";
import { PostgresTenantScheduleLedger } from "../../infrastructure/jobs/PostgresTenantScheduleLedger.js";
import { PostgresEmailDeliveries } from "../../infrastructure/notifications/PostgresEmailDeliveries.js";
import { SmtpEmailSender } from "../../infrastructure/notifications/SmtpEmailSender.js";
import { JobWorker } from "../jobs/JobWorker.js";
import { applicationRoutes } from "../../adapters/routes/applicationRoutes.js";
import { platformRoutes } from "../../adapters/routes/platformRoutes.js";
import type { IApplicationEvents } from "../../application/ports/IApplicationEvents.js";
import type { IApplicationLookups } from "../../application/ports/IApplicationLookups.js";
import type { ISmsSender } from "../../application/ports/ISmsSender.js";
import { ApplicationRiskAssessor } from "../../application/services/ApplicationRiskAssessor.js";
import { ApplicationReview } from "../../application/use-cases/applications/ApplicationReview.js";
import { ApplicationSignup } from "../../application/use-cases/applications/ApplicationSignup.js";
import type { ITenantApplicationRepository } from "../../domain/repositories/ITenantApplicationRepository.js";
import { PostgresApplicationEvents } from "../../infrastructure/applications/PostgresApplicationEvents.js";
import { PostgresApplicationLookups } from "../../infrastructure/applications/PostgresApplicationLookups.js";
import { PostgresTenantApplicationRepository } from "../../infrastructure/applications/PostgresTenantApplicationRepository.js";
import { LoggingSmsSender } from "../../infrastructure/notifications/LoggingSmsSender.js";
import type { IApprovalRequestRepository } from "../../domain/repositories/IApprovalRequestRepository.js";
import type { IStaffAccountRepository } from "../../domain/repositories/IStaffAccountRepository.js";
import type { IKnownDevices } from "../../application/ports/IKnownDevices.js";
import type { IPlatformAuditTrail } from "../../application/ports/IPlatformAuditTrail.js";
import type { IPlatformRoles } from "../../application/ports/IPlatformRoles.js";
import type { IPlatformSessions } from "../../application/ports/IPlatformSessions.js";
import type { IPlatformUnitOfWork } from "../../application/ports/IPlatformUnitOfWork.js";
import type { ISecretBox } from "../../application/ports/ISecretBox.js";
import type { IStaffChallenges } from "../../application/ports/IStaffChallenges.js";
import type { IStaffInvitations } from "../../application/ports/IStaffInvitations.js";
import type { ITotp } from "../../application/ports/ITotp.js";
import { ApprovalWorkflow } from "../../application/use-cases/platform/ApprovalWorkflow.js";
import { StaffAdministration } from "../../application/use-cases/platform/StaffAdministration.js";
import { StaffSessions } from "../../application/use-cases/platform/StaffSessions.js";
import { StaffSignIn } from "../../application/use-cases/platform/StaffSignIn.js";
import { PlatformDb } from "../../infrastructure/platform/PlatformDb.js";
import { PostgresApprovalRequestRepository } from "../../infrastructure/platform/PostgresApprovalRequestRepository.js";
import { PostgresKnownDevices } from "../../infrastructure/platform/PostgresKnownDevices.js";
import { PostgresPlatformAuditTrail } from "../../infrastructure/platform/PostgresPlatformAuditTrail.js";
import { PostgresPlatformRoles } from "../../infrastructure/platform/PostgresPlatformRoles.js";
import { PostgresPlatformSessions } from "../../infrastructure/platform/PostgresPlatformSessions.js";
import { PostgresPlatformUnitOfWork } from "../../infrastructure/platform/PostgresPlatformUnitOfWork.js";
import { PostgresStaffAccountRepository } from "../../infrastructure/platform/PostgresStaffAccountRepository.js";
import { PostgresStaffInvitations } from "../../infrastructure/platform/PostgresStaffInvitations.js";
import { AesGcmSecretBox } from "../../infrastructure/security/AesGcmSecretBox.js";
import { JwtStaffChallenges } from "../../infrastructure/security/JwtStaffChallenges.js";
import { TotpService } from "../../infrastructure/security/TotpService.js";
import { createApp } from "../express/createApp.js";
import { JsonLogger, jsonSink } from "../logger/JsonLogger.js";
import { prettySink } from "../logger/prettySink.js";
import { TYPES } from "./types.js";

/** A step-up (password + code) unlocks sensitive console actions for this long. */
const STEP_UP_WINDOW_MS = 10 * 60_000;
/** Failed staff sign-in steps before a 15-minute lock (docs/27 §2). */
const STAFF_LOCKOUT = Object.freeze({ maxFailedAttempts: 5, lockMs: 15 * 60_000 });
const INVITATION_TTL_MS = 72 * 3_600_000;
const APPROVAL_TTL_MS = 24 * 3_600_000;
/** Trial length offered at approval unless the reviewer changes it (docs/25). */
const DEFAULT_TRIAL_DAYS = 14;
/** A rejected applicant can apply again after this many days, unless the reviewer changes it. */
const DEFAULT_REAPPLY_AFTER_DAYS = 30;
/** New tenants (Ghana market); each changes it in organisation settings. */
const DEFAULT_TENANT_TIMEZONE = "Africa/Accra";
const DEFAULT_BRANCH = Object.freeze({ code: "HQ", name: "Head office" });
const OWNER_INVITATION_TTL_MS = 7 * 86_400_000;
const USER_INVITATION_TTL_MS = 72 * 3_600_000;
/** Failed tenant sign-ins before a 15-minute lock. */
const TENANT_LOCKOUT = Object.freeze({ maxFailedAttempts: 5, lockMs: 15 * 60_000 });

/** This build's version (package.json), shown in the console health summary. */
const APP_VERSION = ((): string => {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

const OPENAPI_INFO = Object.freeze({
  title: "Autoforce Manager API",
  version: "1.0.0",
  description: "Multi-tenant fleet, rentals, work & pay and dealership platform.",
});

/**
 * Composition root. Classes in domain/, application/ and infrastructure/ carry no decorators:
 * every binding is a factory (`toResolvedValue`) listing its dependencies by token, so the inner
 * layers stay free of the DI framework and behave identically under tsc, tsx and Vitest
 * (docs/21_decisions_log.md, decision 67).
 *
 * Resources (pools, the job queue, the SMTP transport) are released through `onDeactivation`;
 * call `disposeContainer` on shutdown.
 */
export type ContainerOptions = Readonly<{
  /** `worker` processes also run queue maintenance and cron schedules. */
  jobQueueMode?: JobQueueMode;
}>;

export function createContainer(
  config: AppConfig,
  migrations: MigrationSets,
  options: ContainerOptions = {},
): Container {
  const container = new Container({ defaultScope: "Singleton" });
  const db = config.database;
  const auth = config.auth;

  container.bind<AppConfig>(TYPES.Config).toConstantValue(config);
  container.bind<MigrationSets>(TYPES.MigrationSets).toConstantValue(migrations);

  // --- Observability ---
  container
    .bind<IRequestContext>(TYPES.RequestContext)
    .toResolvedValue(() => new AsyncLocalRequestContext());

  container.bind<ILogger>(TYPES.Logger).toResolvedValue(
    (requestContext: IRequestContext) =>
      new JsonLogger({
        level: config.logLevel,
        sink: config.logFormat === "pretty" ? prettySink : jsonSink,
        bindings: {
          service: options.jobQueueMode === "worker" ? "autoforce-worker" : "autoforce-api",
        },
        contextProvider: () => {
          const current = requestContext.current();
          return current === undefined ? undefined : { requestId: current.requestId };
        },
      }),
    [TYPES.RequestContext],
  );

  // --- Database infrastructure ---
  container
    .bind<PostgresConnectionFactory>(TYPES.PostgresConnectionFactory)
    .toResolvedValue((c: AppConfig) => new PostgresConnectionFactory(c.database), [TYPES.Config]);

  container
    .bind<TenantDatabaseNaming>(TYPES.TenantDatabaseNaming)
    .toResolvedValue(() => new TenantDatabaseNaming(db.tenantDatabasePrefix));

  container
    .bind<pg.Pool>(TYPES.PlatformDatabasePool)
    .toResolvedValue(
      (factory: PostgresConnectionFactory) =>
        factory.createPool("platform", db.platformDatabase, { max: db.platformPoolMax }),
      [TYPES.PostgresConnectionFactory],
    )
    .onDeactivation((pool) => pool.end());

  container
    .bind<TenantConnectionPools>(TYPES.TenantConnectionPools)
    .toResolvedValue(
      (
        factory: PostgresConnectionFactory,
        naming: TenantDatabaseNaming,
        sets: MigrationSets,
        logger: ILogger,
      ) =>
        new TenantConnectionPools({
          clientConfigFor: (databaseName) => factory.clientConfig("tenant", databaseName),
          databaseNameFor: (tenantId) => naming.databaseNameFor(tenantId),
          maxPools: db.tenantPools.maxPools,
          maxConnectionsPerPool: db.tenantPools.maxConnections,
          idleTimeoutMs: db.tenantPools.idleTimeoutMs,
          statementTimeoutMs: db.statementTimeoutMs,
          requiredSchemaVersion: sets.tenant.latestVersion,
          onPoolError: (error, tenantId) =>
            logger.warn("Tenant database pool error", { tenantId, error }),
        }),
      [
        TYPES.PostgresConnectionFactory,
        TYPES.TenantDatabaseNaming,
        TYPES.MigrationSets,
        TYPES.Logger,
      ],
    )
    .onDeactivation((pools) => pools.closeAll());

  container
    .bind<PostgresTransactionContext>(TYPES.PostgresTransactionContext)
    .toResolvedValue(() => new PostgresTransactionContext());

  container
    .bind<MigrationRunner>(TYPES.MigrationRunner)
    .toResolvedValue(() => new MigrationRunner());

  // --- Application ports ---
  container
    .bind<ITenantContext>(TYPES.TenantContext)
    .toResolvedValue(() => new AsyncLocalTenantContext());

  container
    .bind<IUnitOfWork>(TYPES.UnitOfWork)
    .toResolvedValue(
      (
        tenantContext: ITenantContext,
        pools: TenantConnectionPools,
        tx: PostgresTransactionContext,
        logger: ILogger,
      ) =>
        new PostgresTenantUnitOfWork(tenantContext, pools, tx, (error) =>
          logger.warn("After-commit hook failed", { error }),
        ),
      [
        TYPES.TenantContext,
        TYPES.TenantConnectionPools,
        TYPES.PostgresTransactionContext,
        TYPES.Logger,
      ],
    );

  container
    .bind<ISequenceGenerator>(TYPES.SequenceGenerator)
    .toResolvedValue(
      (tx: PostgresTransactionContext) => new PostgresSequenceGenerator(tx),
      [TYPES.PostgresTransactionContext],
    );

  container
    .bind<IAuditTrail>(TYPES.AuditTrail)
    .toResolvedValue(
      (tx: PostgresTransactionContext) => new PostgresAuditTrail(tx),
      [TYPES.PostgresTransactionContext],
    );

  container.bind<IOutbox>(TYPES.Outbox).toResolvedValue(
    (tx: PostgresTransactionContext, tenantContext: ITenantContext, queue: IJobQueue) =>
      // After commit, ask the worker to publish this tenant's new events.
      new PostgresOutbox(tx, async () => {
        const tenantId = tenantContext.currentTenantId().value;
        await queue.enqueue("outbox.drain", { tenantId }, { singletonKey: tenantId });
      }),
    [TYPES.PostgresTransactionContext, TYPES.TenantContext, TYPES.JobQueue],
  );

  // --- Background jobs, events and notifications ---
  container
    .bind<PgBossJobQueue>(TYPES.JobQueue)
    .toResolvedValue(
      (factory: PostgresConnectionFactory, logger: ILogger) =>
        new PgBossJobQueue(
          new PgBoss(
            pgBossOptions(
              factory.clientConfig("platform", db.platformDatabase),
              options.jobQueueMode ?? "api",
              config.jobs.poolMax,
            ),
          ),
          (error) => logger.error("Job queue error", { error }),
        ),
      [TYPES.PostgresConnectionFactory, TYPES.Logger],
    )
    .onDeactivation((queue) => queue.stop(config.shutdownTimeoutMs));

  container
    .bind<IOutboxStore>(TYPES.OutboxStore)
    .toResolvedValue(
      (tx: PostgresTransactionContext) => new PostgresOutboxStore(tx),
      [TYPES.PostgresTransactionContext],
    );

  container
    .bind<IProcessedMessages>(TYPES.ProcessedMessages)
    .toResolvedValue(
      (tx: PostgresTransactionContext) => new PostgresProcessedMessages(tx),
      [TYPES.PostgresTransactionContext],
    );

  container
    .bind<ITenantRetention>(TYPES.TenantRetention)
    .toResolvedValue(
      (tx: PostgresTransactionContext) => new PostgresTenantRetention(tx),
      [TYPES.PostgresTransactionContext],
    );

  container
    .bind<ITenantRoster>(TYPES.TenantRoster)
    .toResolvedValue(
      (pool: pg.Pool) => new PostgresTenantRoster(pool),
      [TYPES.PlatformDatabasePool],
    );

  container
    .bind<ITenantScheduleLedger>(TYPES.TenantScheduleLedger)
    .toResolvedValue(
      (pool: pg.Pool, queue: PgBossJobQueue) => new PostgresTenantScheduleLedger(pool, queue),
      [TYPES.PlatformDatabasePool, TYPES.JobQueue],
    );

  // Modules register their event handlers here as they are built.
  container.bind<IEventHandler[]>(TYPES.EventHandlers).toConstantValue([]);

  container
    .bind<EventHandlerRegistry>(TYPES.EventHandlerRegistry)
    .toResolvedValue(
      (handlers: IEventHandler[]) => new EventHandlerRegistry(handlers),
      [TYPES.EventHandlers],
    );

  container
    .bind<IEmailDeliveries>(TYPES.EmailDeliveries)
    .toResolvedValue(
      (pool: pg.Pool, queue: PgBossJobQueue) => new PostgresEmailDeliveries(pool, queue),
      [TYPES.PlatformDatabasePool, TYPES.JobQueue],
    );

  container
    .bind<SmtpEmailSender>(TYPES.EmailSender)
    .toResolvedValue(() => new SmtpEmailSender({ ...config.email.smtp, from: config.email.from }))
    .onDeactivation((sender) => sender.close());

  container
    .bind<NotificationService>(TYPES.NotificationService)
    .toResolvedValue(
      (deliveries: IEmailDeliveries) => new NotificationService(deliveries),
      [TYPES.EmailDeliveries],
    );

  container
    .bind<IJobHandler[]>(TYPES.JobHandlers)
    .toResolvedValue(
      (
        unitOfWork: IUnitOfWork,
        outbox: IOutboxStore,
        processed: IProcessedMessages,
        handlers: EventHandlerRegistry,
        queue: IJobQueue,
        roster: ITenantRoster,
        ledger: ITenantScheduleLedger,
        retention: ITenantRetention,
        deliveries: IEmailDeliveries,
        sender: IEmailSender,
        clock: IClock,
        logger: ILogger,
        provisioningHandlers: IJobHandler[],
        tenantFiles: FileService,
        platformFiles: FileService,
      ): IJobHandler[] => [
        new DrainOutbox({ unitOfWork, outbox, handlers, queue, clock }),
        new SweepOutboxes({ roster, queue }),
        new DeliverEvent({ unitOfWork, processed, handlers, logger }),
        new RunTenantSchedules({ roster, ledger, clock, logger }),
        new RunDailyMaintenance({ unitOfWork, retention, clock, logger, files: tenantFiles }),
        new SendQueuedEmail({ deliveries, sender, clock, logger }),
        new SweepAbandonedFiles({ files: platformFiles, logger }),
        ...provisioningHandlers,
      ],
      [
        TYPES.UnitOfWork,
        TYPES.OutboxStore,
        TYPES.ProcessedMessages,
        TYPES.EventHandlerRegistry,
        TYPES.JobQueue,
        TYPES.TenantRoster,
        TYPES.TenantScheduleLedger,
        TYPES.TenantRetention,
        TYPES.EmailDeliveries,
        TYPES.EmailSender,
        TYPES.Clock,
        TYPES.Logger,
        TYPES.ProvisioningJobHandlers,
        TYPES.TenantFileService,
        TYPES.PlatformFileService,
      ],
    );

  container.bind<JobWorker>(TYPES.JobWorker).toResolvedValue(
    (
      queue: PgBossJobQueue,
      handlers: IJobHandler[],
      tenantContext: ITenantContext,
      tenants: ITenantDirectory,
      requestContext: IRequestContext,
      logger: ILogger,
    ) =>
      new JobWorker({
        queue,
        handlers,
        tenantContext,
        tenants,
        requestContext,
        logger,
        concurrency: config.jobs.workerConcurrency,
      }),
    [
      TYPES.JobQueue,
      TYPES.JobHandlers,
      TYPES.TenantContext,
      TYPES.TenantDirectory,
      TYPES.RequestContext,
      TYPES.Logger,
    ],
  );

  container.bind<ITenantDatabaseProvisioner>(TYPES.TenantDatabaseProvisioner).toResolvedValue(
    (factory: PostgresConnectionFactory, naming: TenantDatabaseNaming) =>
      new TenantDatabaseProvisioner({
        connect: (database) => factory.connect("migrator", database),
        maintenanceDatabase: db.platformDatabase,
        templateDatabase: db.tenantTemplateDatabase,
        databaseNameFor: (tenantId) => naming.databaseNameFor(tenantId),
      }),
    [TYPES.PostgresConnectionFactory, TYPES.TenantDatabaseNaming],
  );

  // --- Security and identity ---
  container.bind<IClock>(TYPES.Clock).toResolvedValue(() => new SystemClock());
  container.bind<IIdGenerator>(TYPES.IdGenerator).toResolvedValue(() => new UuidV7Generator());
  container
    .bind<IPasswordHasher>(TYPES.PasswordHasher)
    .toResolvedValue(() => new Argon2PasswordHasher());

  container.bind<IAccessTokenService>(TYPES.AccessTokenService).toResolvedValue(
    (clock: IClock) =>
      new JwtAccessTokenService(
        {
          tenantSecret: auth.tenantJwtSecret,
          platformSecret: auth.platformJwtSecret,
          issuer: auth.issuer,
          ttlSeconds: auth.accessTokenTtlSeconds,
          platformTtlSeconds: auth.platform.accessTokenTtlSeconds,
        },
        clock,
      ),
    [TYPES.Clock],
  );

  container
    .bind<IRefreshTokenService>(TYPES.RefreshTokenService)
    .toResolvedValue(() => new CryptoRefreshTokenService());

  container
    .bind<IOtpService>(TYPES.OtpService)
    .toResolvedValue(() => new HmacOtpService(auth.otpSecret));

  container
    .bind<ITenantDirectory>(TYPES.TenantDirectory)
    .toResolvedValue(
      (pool: pg.Pool) => new PostgresTenantDirectory(pool),
      [TYPES.PlatformDatabasePool],
    );

  // Until the identity module (P1-5) exists no tenant user can be authenticated.
  container
    .bind<IPermissionResolver>(TYPES.PermissionResolver)
    .toResolvedValue(
      (pools: TenantConnectionPools) =>
        new CachingPermissionResolver(new PostgresTenantPermissionResolver(pools)),
      [TYPES.TenantConnectionPools],
    );
  // The same caching resolver, seen as the cache to invalidate after permission-relevant changes.
  container
    .bind<IPermissionCache>(TYPES.PermissionCache)
    .toResolvedValue(
      (resolver: IPermissionResolver) => resolver as CachingPermissionResolver,
      [TYPES.PermissionResolver],
    );

  container
    .bind<IAuthSessionRepository>(TYPES.AuthSessionRepository)
    .toResolvedValue(
      (tx: PostgresTransactionContext) => new PostgresAuthSessionRepository(tx),
      [TYPES.PostgresTransactionContext],
    );

  container
    .bind<IOtpChallengeRepository>(TYPES.OtpChallengeRepository)
    .toResolvedValue(
      (tx: PostgresTransactionContext) => new PostgresOtpChallengeRepository(tx),
      [TYPES.PostgresTransactionContext],
    );

  container
    .bind<AuthorizationPolicy>(TYPES.AuthorizationPolicy)
    .toResolvedValue(() => new AuthorizationPolicy());

  container.bind<StartAuthSession>(TYPES.StartAuthSession).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      tenantContext: ITenantContext,
      sessions: IAuthSessionRepository,
      accessTokens: IAccessTokenService,
      refreshTokens: IRefreshTokenService,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new StartAuthSession({
        unitOfWork,
        tenantContext,
        sessions,
        accessTokens,
        refreshTokens,
        auditTrail,
        requestContext,
        ids,
        clock,
        settings: { refreshTokenTtlMs: auth.refreshTokenTtlDays * 86_400_000 },
      }),
    [
      TYPES.UnitOfWork,
      TYPES.TenantContext,
      TYPES.AuthSessionRepository,
      TYPES.AccessTokenService,
      TYPES.RefreshTokenService,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );

  container.bind<RefreshAuthSession>(TYPES.RefreshAuthSession).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      tenantContext: ITenantContext,
      sessions: IAuthSessionRepository,
      accessTokens: IAccessTokenService,
      refreshTokens: IRefreshTokenService,
      permissions: IPermissionResolver,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      clock: IClock,
    ) =>
      new RefreshAuthSession({
        unitOfWork,
        tenantContext,
        sessions,
        accessTokens,
        refreshTokens,
        permissions,
        auditTrail,
        requestContext,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.TenantContext,
      TYPES.AuthSessionRepository,
      TYPES.AccessTokenService,
      TYPES.RefreshTokenService,
      TYPES.PermissionResolver,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.Clock,
    ],
  );

  container
    .bind<RevokeAuthSession>(TYPES.RevokeAuthSession)
    .toResolvedValue(
      (
        unitOfWork: IUnitOfWork,
        sessions: IAuthSessionRepository,
        auditTrail: IAuditTrail,
        requestContext: IRequestContext,
        clock: IClock,
      ) => new RevokeAuthSession({ unitOfWork, sessions, auditTrail, requestContext, clock }),
      [
        TYPES.UnitOfWork,
        TYPES.AuthSessionRepository,
        TYPES.AuditTrail,
        TYPES.RequestContext,
        TYPES.Clock,
      ],
    );

  container
    .bind<AuthenticateTenantRequest>(TYPES.AuthenticateTenantRequest)
    .toResolvedValue(
      (
        accessTokens: IAccessTokenService,
        tenants: ITenantDirectory,
        permissions: IPermissionResolver,
      ) => new AuthenticateTenantRequest({ accessTokens, tenants, permissions }),
      [TYPES.AccessTokenService, TYPES.TenantDirectory, TYPES.PermissionResolver],
    );

  container
    .bind<ResolveTenant>(TYPES.ResolveTenant)
    .toResolvedValue(
      (tenants: ITenantDirectory) => new ResolveTenant(tenants),
      [TYPES.TenantDirectory],
    );

  container.bind<IssueOtpChallenge>(TYPES.IssueOtpChallenge).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      challenges: IOtpChallengeRepository,
      otp: IOtpService,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new IssueOtpChallenge({
        unitOfWork,
        challenges,
        otp,
        ids,
        clock,
        settings: { ttlMs: auth.otpTtlMinutes * 60_000, maxAttempts: auth.otpMaxAttempts },
      }),
    [
      TYPES.UnitOfWork,
      TYPES.OtpChallengeRepository,
      TYPES.OtpService,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );

  container
    .bind<VerifyOtpChallenge>(TYPES.VerifyOtpChallenge)
    .toResolvedValue(
      (
        unitOfWork: IUnitOfWork,
        challenges: IOtpChallengeRepository,
        otp: IOtpService,
        clock: IClock,
      ) => new VerifyOtpChallenge({ unitOfWork, challenges, otp, clock }),
      [TYPES.UnitOfWork, TYPES.OtpChallengeRepository, TYPES.OtpService, TYPES.Clock],
    );

  // --- Platform console: staff, sessions, approvals, audit ---
  container
    .bind<PostgresTransactionContext>(TYPES.PlatformTransactionContext)
    .toResolvedValue(() => new PostgresTransactionContext());

  container
    .bind<PlatformDb>(TYPES.PlatformDb)
    .toResolvedValue(
      (pool: pg.Pool, tx: PostgresTransactionContext) => new PlatformDb(pool, tx),
      [TYPES.PlatformDatabasePool, TYPES.PlatformTransactionContext],
    );

  container
    .bind<IPlatformUnitOfWork>(TYPES.PlatformUnitOfWork)
    .toResolvedValue(
      (pool: pg.Pool, tx: PostgresTransactionContext) =>
        new PostgresPlatformUnitOfWork(pool, tx, db.statementTimeoutMs),
      [TYPES.PlatformDatabasePool, TYPES.PlatformTransactionContext],
    );

  const platformRepository = <T>(token: symbol, build: (platformDb: PlatformDb) => T) =>
    container.bind<T>(token).toResolvedValue(build, [TYPES.PlatformDb]);
  platformRepository<IStaffAccountRepository>(
    TYPES.StaffAccountRepository,
    (p) => new PostgresStaffAccountRepository(p),
  );
  platformRepository<IPlatformRoles>(TYPES.PlatformRoles, (p) => new PostgresPlatformRoles(p));
  platformRepository<IStaffInvitations>(
    TYPES.StaffInvitations,
    (p) => new PostgresStaffInvitations(p),
  );
  platformRepository<IPlatformSessions>(
    TYPES.PlatformSessions,
    (p) => new PostgresPlatformSessions(p),
  );
  platformRepository<IApprovalRequestRepository>(
    TYPES.ApprovalRequestRepository,
    (p) => new PostgresApprovalRequestRepository(p),
  );
  platformRepository<IPlatformAuditTrail>(
    TYPES.PlatformAuditTrail,
    (p) => new PostgresPlatformAuditTrail(p),
  );
  platformRepository<IKnownDevices>(TYPES.KnownDevices, (p) => new PostgresKnownDevices(p));

  container.bind<ITotp>(TYPES.Totp).toResolvedValue(() => new TotpService());
  container
    .bind<ISecretBox>(TYPES.SecretBox)
    .toResolvedValue(() => new AesGcmSecretBox(auth.mfaEncryptionKey));
  container
    .bind<IStaffChallenges>(TYPES.StaffChallenges)
    .toResolvedValue(
      (clock: IClock) => new JwtStaffChallenges(auth.platformJwtSecret, auth.issuer, clock),
      [TYPES.Clock],
    );

  container.bind<StaffSessions>(TYPES.StaffSessions).toResolvedValue(
    (
      unitOfWork: IPlatformUnitOfWork,
      accounts: IStaffAccountRepository,
      roles: IPlatformRoles,
      sessions: IPlatformSessions,
      accessTokens: IAccessTokenService,
      refreshTokens: IRefreshTokenService,
      audit: IPlatformAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
      partners: IPartnerRepository,
    ) =>
      new StaffSessions({
        unitOfWork,
        accounts,
        roles,
        partners,
        sessions,
        accessTokens,
        refreshTokens,
        audit,
        requestContext,
        ids,
        clock,
        settings: {
          idleMs: auth.platform.sessionIdleMinutes * 60_000,
          maxMs: auth.platform.sessionMaxHours * 3_600_000,
          stepUpMs: STEP_UP_WINDOW_MS,
        },
      }),
    [
      TYPES.PlatformUnitOfWork,
      TYPES.StaffAccountRepository,
      TYPES.PlatformRoles,
      TYPES.PlatformSessions,
      TYPES.AccessTokenService,
      TYPES.RefreshTokenService,
      TYPES.PlatformAuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
      TYPES.PartnerRepository,
    ],
  );

  container.bind<StaffSignIn>(TYPES.StaffSignIn).toResolvedValue(
    (
      unitOfWork: IPlatformUnitOfWork,
      accounts: IStaffAccountRepository,
      invitations: IStaffInvitations,
      roles: IPlatformRoles,
      sessions: StaffSessions,
      sessionStore: IPlatformSessions,
      challenges: IStaffChallenges,
      passwords: IPasswordHasher,
      totp: ITotp,
      secrets: ISecretBox,
      devices: IKnownDevices,
      notifications: NotificationService,
      audit: IPlatformAuditTrail,
      clock: IClock,
    ) =>
      new StaffSignIn({
        unitOfWork,
        accounts,
        invitations,
        roles,
        sessions,
        sessionStore,
        challenges,
        passwords,
        totp,
        secrets,
        devices,
        notifications,
        audit,
        clock,
        lockout: STAFF_LOCKOUT,
      }),
    [
      TYPES.PlatformUnitOfWork,
      TYPES.StaffAccountRepository,
      TYPES.StaffInvitations,
      TYPES.PlatformRoles,
      TYPES.StaffSessions,
      TYPES.PlatformSessions,
      TYPES.StaffChallenges,
      TYPES.PasswordHasher,
      TYPES.Totp,
      TYPES.SecretBox,
      TYPES.KnownDevices,
      TYPES.NotificationService,
      TYPES.PlatformAuditTrail,
      TYPES.Clock,
    ],
  );

  container.bind<ApprovalWorkflow>(TYPES.ApprovalWorkflow).toResolvedValue(
    (
      unitOfWork: IPlatformUnitOfWork,
      approvals: IApprovalRequestRepository,
      roles: IPlatformRoles,
      audit: IPlatformAuditTrail,
      notifications: NotificationService,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new ApprovalWorkflow({
        unitOfWork,
        approvals,
        roles,
        audit,
        notifications,
        requestContext,
        ids,
        clock,
        ttlMs: APPROVAL_TTL_MS,
      }),
    [
      TYPES.PlatformUnitOfWork,
      TYPES.ApprovalRequestRepository,
      TYPES.PlatformRoles,
      TYPES.PlatformAuditTrail,
      TYPES.NotificationService,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );

  container.bind<StaffAdministration>(TYPES.StaffAdministration).toResolvedValue(
    (
      unitOfWork: IPlatformUnitOfWork,
      accounts: IStaffAccountRepository,
      roles: IPlatformRoles,
      invitations: IStaffInvitations,
      sessions: IPlatformSessions,
      approvals: ApprovalWorkflow,
      notifications: NotificationService,
      audit: IPlatformAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) => {
      const administration = new StaffAdministration({
        unitOfWork,
        accounts,
        roles,
        invitations,
        sessions,
        approvals,
        notifications,
        audit,
        requestContext,
        ids,
        clock,
        settings: {
          invitationTtlMs: INVITATION_TTL_MS,
          consoleUrl: auth.platform.consoleUrl,
        },
      });
      approvals.register(administration.roleChangeExecutor());
      return administration;
    },
    [
      TYPES.PlatformUnitOfWork,
      TYPES.StaffAccountRepository,
      TYPES.PlatformRoles,
      TYPES.StaffInvitations,
      TYPES.PlatformSessions,
      TYPES.ApprovalWorkflow,
      TYPES.NotificationService,
      TYPES.PlatformAuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );

  // --- Tenant applications (public signup and review queue) ---
  platformRepository<ITenantApplicationRepository>(
    TYPES.TenantApplicationRepository,
    (p) => new PostgresTenantApplicationRepository(p),
  );
  platformRepository<IApplicationEvents>(
    TYPES.ApplicationEvents,
    (p) => new PostgresApplicationEvents(p),
  );
  platformRepository<IApplicationLookups>(
    TYPES.ApplicationLookups,
    (p) => new PostgresApplicationLookups(p),
  );

  container
    .bind<ISmsSender>(TYPES.SmsSender)
    .toResolvedValue(
      (logger: ILogger) => new LoggingSmsSender(logger, config.isProduction),
      [TYPES.Logger],
    );

  container.bind<ApplicationSignup>(TYPES.ApplicationSignup).toResolvedValue(
    (
      unitOfWork: IPlatformUnitOfWork,
      platformDb: PlatformDb,
      applications: ITenantApplicationRepository,
      events: IApplicationEvents,
      lookups: IApplicationLookups,
      otp: IOtpService,
      ids: IIdGenerator,
      clock: IClock,
      notifications: NotificationService,
      sms: ISmsSender,
      audit: IPlatformAuditTrail,
      partners: IPartnerRepository,
    ) => {
      // Signup codes live in the platform database (there is no tenant yet).
      const challenges = new PostgresOtpChallengeRepository(
        { current: () => platformDb },
        "platform_otp_challenges",
      );
      return new ApplicationSignup({
        unitOfWork,
        applications,
        partners,
        events,
        lookups,
        risk: new ApplicationRiskAssessor(lookups),
        issueOtp: new IssueOtpChallenge({
          unitOfWork,
          challenges,
          otp,
          ids,
          clock,
          settings: { ttlMs: auth.otpTtlMinutes * 60_000, maxAttempts: auth.otpMaxAttempts },
        }),
        verifyOtp: new VerifyOtpChallenge({ unitOfWork, challenges, otp, clock }),
        notifications,
        sms,
        audit,
        ids,
        clock,
        settings: { webAppUrl: config.public.webAppUrl, otpTtlMinutes: auth.otpTtlMinutes },
      });
    },
    [
      TYPES.PlatformUnitOfWork,
      TYPES.PlatformDb,
      TYPES.TenantApplicationRepository,
      TYPES.ApplicationEvents,
      TYPES.ApplicationLookups,
      TYPES.OtpService,
      TYPES.IdGenerator,
      TYPES.Clock,
      TYPES.NotificationService,
      TYPES.SmsSender,
      TYPES.PlatformAuditTrail,
      TYPES.PartnerRepository,
    ],
  );

  container.bind<ApplicationReview>(TYPES.ApplicationReview).toResolvedValue(
    (
      unitOfWork: IPlatformUnitOfWork,
      applications: ITenantApplicationRepository,
      events: IApplicationEvents,
      lookups: IApplicationLookups,
      staff: IStaffAccountRepository,
      notifications: NotificationService,
      audit: IPlatformAuditTrail,
      requestContext: IRequestContext,
      clock: IClock,
      provisioning: ITenantProvisioning,
      queue: IJobQueue,
      ids: IIdGenerator,
      attributions: IPartnerAttributions,
    ) =>
      new ApplicationReview({
        attributions,
        unitOfWork,
        applications,
        events,
        lookups,
        staff,
        notifications,
        audit,
        requestContext,
        provisioning,
        queue,
        ids,
        clock,
        settings: {
          webAppUrl: config.public.webAppUrl,
          defaultTimezone: DEFAULT_TENANT_TIMEZONE,
          defaultTrialDays: DEFAULT_TRIAL_DAYS,
          defaultReapplyAfterDays: DEFAULT_REAPPLY_AFTER_DAYS,
        },
      }),
    [
      TYPES.PlatformUnitOfWork,
      TYPES.TenantApplicationRepository,
      TYPES.ApplicationEvents,
      TYPES.ApplicationLookups,
      TYPES.StaffAccountRepository,
      TYPES.NotificationService,
      TYPES.PlatformAuditTrail,
      TYPES.RequestContext,
      TYPES.Clock,
      TYPES.TenantProvisioning,
      TYPES.JobQueue,
      TYPES.IdGenerator,
      TYPES.PartnerAttributions,
    ],
  );

  // --- Reseller programme (partners, partner portal) ---
  platformRepository<IPartnerRepository>(
    TYPES.PartnerRepository,
    (p) => new PostgresPartnerRepository(p),
  );
  platformRepository<IPartnerQueries>(TYPES.PartnerQueries, (p) => new PostgresPartnerQueries(p));
  platformRepository<IPartnerAttributions>(
    TYPES.PartnerAttributions,
    (p) => new PostgresPartnerAttributions(p),
  );
  container.bind<PartnerAdministration>(TYPES.PartnerAdministration).toResolvedValue(
    (
      partners: IPartnerRepository,
      queries: IPartnerQueries,
      attributions: IPartnerAttributions,
      accounts: IStaffAccountRepository,
      sessions: IPlatformSessions,
      staff: StaffAdministration,
      directory: ITenantDirectory,
      unitOfWork: IPlatformUnitOfWork,
      audit: IPlatformAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new PartnerAdministration({
        partners,
        queries,
        attributions,
        accounts,
        sessions,
        staff,
        directory,
        unitOfWork,
        audit,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.PartnerRepository,
      TYPES.PartnerQueries,
      TYPES.PartnerAttributions,
      TYPES.StaffAccountRepository,
      TYPES.PlatformSessions,
      TYPES.StaffAdministration,
      TYPES.TenantDirectory,
      TYPES.PlatformUnitOfWork,
      TYPES.PlatformAuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<PartnerPortal>(TYPES.PartnerPortal).toResolvedValue(
    (
      queries: IPartnerQueries,
      partners: IPartnerRepository,
      accounts: IStaffAccountRepository,
      sessions: IPlatformSessions,
      signup: ApplicationSignup,
      staff: StaffAdministration,
      unitOfWork: IPlatformUnitOfWork,
      audit: IPlatformAuditTrail,
      requestContext: IRequestContext,
      clock: IClock,
    ) =>
      new PartnerPortal({
        queries,
        partners,
        accounts,
        sessions,
        signup,
        staff,
        unitOfWork,
        audit,
        requestContext,
        clock,
        settings: { signupUrl: config.public.webAppUrl },
      }),
    [
      TYPES.PartnerQueries,
      TYPES.PartnerRepository,
      TYPES.StaffAccountRepository,
      TYPES.PlatformSessions,
      TYPES.ApplicationSignup,
      TYPES.StaffAdministration,
      TYPES.PlatformUnitOfWork,
      TYPES.PlatformAuditTrail,
      TYPES.RequestContext,
      TYPES.Clock,
    ],
  );

  // --- Provisioning (saga, catalogue sync, owner first login) ---
  platformRepository<IPermissionCatalogueSource>(
    TYPES.PermissionCatalogueSource,
    (p) => new PostgresPermissionCatalogueSource(p),
  );
  platformRepository<ITenantProvisioning>(
    TYPES.TenantProvisioning,
    (p) => new PostgresTenantProvisioning(p),
  );
  platformRepository<IUserDirectory>(
    TYPES.UserDirectory,
    (p) => new HmacUserDirectory(p, auth.otpSecret),
  );
  container
    .bind<IOrphanDatabases>(TYPES.OrphanDatabases)
    .toResolvedValue(
      (platformDb: PlatformDb, naming: TenantDatabaseNaming) =>
        new PostgresOrphanDatabases(platformDb, naming, db.tenantDatabasePrefix),
      [TYPES.PlatformDb, TYPES.TenantDatabaseNaming],
    );
  container
    .bind<ITenantSchemaUpdater>(TYPES.TenantSchemaUpdater)
    .toResolvedValue(
      (
        factory: PostgresConnectionFactory,
        naming: TenantDatabaseNaming,
        runner: MigrationRunner,
        sets: MigrationSets,
      ) => new MigratorTenantSchemaUpdater(factory, naming, runner, sets.tenant),
      [
        TYPES.PostgresConnectionFactory,
        TYPES.TenantDatabaseNaming,
        TYPES.MigrationRunner,
        TYPES.MigrationSets,
      ],
    );
  container
    .bind<ITenantSeeder>(TYPES.TenantSeeder)
    .toResolvedValue(
      (tx: PostgresTransactionContext) => new PostgresTenantSeeder(tx),
      [TYPES.PostgresTransactionContext],
    );
  container
    .bind<IUserInvitations>(TYPES.UserInvitations)
    .toResolvedValue(
      (tx: PostgresTransactionContext) => new PostgresUserInvitations(tx),
      [TYPES.PostgresTransactionContext],
    );
  container
    .bind<ITenantUserAccounts>(TYPES.TenantUserAccounts)
    .toResolvedValue(
      (tx: PostgresTransactionContext) => new PostgresTenantUserAccounts(tx),
      [TYPES.PostgresTransactionContext],
    );

  container.bind<IJobHandler[]>(TYPES.ProvisioningJobHandlers).toResolvedValue(
    (
      provisioning: ITenantProvisioning,
      databases: ITenantDatabaseProvisioner,
      schema: ITenantSchemaUpdater,
      catalogue: IPermissionCatalogueSource,
      tenantContext: ITenantContext,
      unitOfWork: IUnitOfWork,
      seeder: ITenantSeeder,
      invitations: IUserInvitations,
      directory: IUserDirectory,
      notifications: NotificationService,
      audit: IPlatformAuditTrail,
      orphans: IOrphanDatabases,
      queue: IJobQueue,
      clock: IClock,
      logger: ILogger,
      subscriptions: SubscriptionAdministration,
    ): IJobHandler[] => [
      new ProvisionTenant({
        subscriptions,
        provisioning,
        databases,
        schema,
        catalogue,
        tenantContext,
        unitOfWork,
        seeder,
        invitations,
        directory,
        notifications,
        audit,
        clock,
        logger,
        settings: {
          webAppUrl: config.public.webAppUrl,
          ownerInvitationTtlMs: OWNER_INVITATION_TTL_MS,
          defaultBranch: DEFAULT_BRANCH,
        },
      }),
      new SweepProvisioning({ provisioning, orphans, queue, audit, clock, logger }),
      new SweepCatalogue({ provisioning, catalogue, queue }),
      new SyncTenantCatalogue({ catalogue, unitOfWork, seeder, provisioning, logger }),
    ],
    [
      TYPES.TenantProvisioning,
      TYPES.TenantDatabaseProvisioner,
      TYPES.TenantSchemaUpdater,
      TYPES.PermissionCatalogueSource,
      TYPES.TenantContext,
      TYPES.UnitOfWork,
      TYPES.TenantSeeder,
      TYPES.UserInvitations,
      TYPES.UserDirectory,
      TYPES.NotificationService,
      TYPES.PlatformAuditTrail,
      TYPES.OrphanDatabases,
      TYPES.JobQueue,
      TYPES.Clock,
      TYPES.Logger,
      TYPES.SubscriptionAdministration,
    ],
  );

  container
    .bind<ProvisioningConsole>(TYPES.ProvisioningConsole)
    .toResolvedValue(
      (
        provisioning: ITenantProvisioning,
        queue: IJobQueue,
        audit: IPlatformAuditTrail,
        requestContext: IRequestContext,
      ) => new ProvisioningConsole({ provisioning, queue, audit, requestContext }),
      [TYPES.TenantProvisioning, TYPES.JobQueue, TYPES.PlatformAuditTrail, TYPES.RequestContext],
    );

  container.bind<AcceptUserInvitation>(TYPES.AcceptUserInvitation).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      invitations: IUserInvitations,
      users: ITenantUserAccounts,
      passwords: IPasswordHasher,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      startSession: StartAuthSession,
      clock: IClock,
      tenantContext: ITenantContext,
      directory: IUserDirectory,
    ) =>
      new AcceptUserInvitation({
        tenantContext,
        directory,
        unitOfWork,
        invitations,
        users,
        passwords,
        auditTrail,
        requestContext,
        startSession,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.UserInvitations,
      TYPES.TenantUserAccounts,
      TYPES.PasswordHasher,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.StartAuthSession,
      TYPES.Clock,
      TYPES.TenantContext,
      TYPES.UserDirectory,
    ],
  );

  // --- Tenant and branch lifecycle, public tenant-config ---
  platformRepository<ITenantLifecycleRepository>(
    TYPES.TenantLifecycleRepository,
    (p) => new PostgresTenantLifecycleRepository(p),
  );
  platformRepository<ITenantPublicProfiles>(
    TYPES.TenantPublicProfiles,
    (p) => new PostgresTenantPublicProfiles(p),
  );
  const tenantRepository = <T>(token: symbol, build: (tx: PostgresTransactionContext) => T) =>
    container.bind<T>(token).toResolvedValue(build, [TYPES.PostgresTransactionContext]);
  tenantRepository<ITenantSessionRevoker>(
    TYPES.TenantSessionRevoker,
    (tx) => new PostgresTenantSessionRevoker(tx),
  );
  tenantRepository<IBranches>(TYPES.Branches, (tx) => new PostgresBranches(tx));
  tenantRepository<IOrganisationReader>(
    TYPES.OrganisationReader,
    (tx) => new PostgresOrganisationReader(tx),
  );
  // Modules register their branch-deactivation checks here (open rentals, cash sessions, …).
  container.bind<IBranchDeactivationCheck[]>(TYPES.BranchDeactivationChecks).toConstantValue([]);

  container.bind<TenantLifecycleService>(TYPES.TenantLifecycleService).toResolvedValue(
    (
      platformUnitOfWork: IPlatformUnitOfWork,
      tenants: ITenantLifecycleRepository,
      directory: ITenantDirectory,
      tenantContext: ITenantContext,
      tenantUnitOfWork: IUnitOfWork,
      sessions: ITenantSessionRevoker,
      seeder: ITenantSeeder,
      notifications: NotificationService,
      audit: IPlatformAuditTrail,
      requestContext: IRequestContext,
      clock: IClock,
      logger: ILogger,
    ) =>
      new TenantLifecycleService({
        platformUnitOfWork,
        tenants,
        directory,
        tenantContext,
        tenantUnitOfWork,
        sessions,
        seeder,
        notifications,
        audit,
        requestContext,
        clock,
        logger,
      }),
    [
      TYPES.PlatformUnitOfWork,
      TYPES.TenantLifecycleRepository,
      TYPES.TenantDirectory,
      TYPES.TenantContext,
      TYPES.UnitOfWork,
      TYPES.TenantSessionRevoker,
      TYPES.TenantSeeder,
      TYPES.NotificationService,
      TYPES.PlatformAuditTrail,
      TYPES.RequestContext,
      TYPES.Clock,
      TYPES.Logger,
    ],
  );

  container.bind<BranchLifecycle>(TYPES.BranchLifecycle).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      branches: IBranches,
      checks: IBranchDeactivationCheck[],
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      clock: IClock,
      tenantContext: ITenantContext,
      permissionCache: IPermissionCache,
      entitlements: BranchEntitlements,
    ) =>
      new BranchLifecycle({
        unitOfWork,
        branches,
        checks,
        auditTrail,
        requestContext,
        tenantContext,
        permissionCache,
        clock,
        entitlements,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.Branches,
      TYPES.BranchDeactivationChecks,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.Clock,
      TYPES.TenantContext,
      TYPES.PermissionCache,
      TYPES.BranchEntitlements,
    ],
  );

  container.bind<TenantPublicConfig>(TYPES.TenantPublicConfig).toResolvedValue(
    (
      profiles: ITenantPublicProfiles,
      tenantContext: ITenantContext,
      unitOfWork: IUnitOfWork,
      organisation: IOrganisationReader,
      clock: IClock,
      storage: IObjectStorage,
      mobile: MobileConnect,
    ) =>
      new TenantPublicConfig({
        profiles,
        tenantContext,
        unitOfWork,
        organisation,
        clock,
        storage,
        app: mobile.appInfo(),
      }),
    [
      TYPES.TenantPublicProfiles,
      TYPES.TenantContext,
      TYPES.UnitOfWork,
      TYPES.OrganisationReader,
      TYPES.Clock,
      TYPES.ObjectStorage,
      TYPES.MobileConnect,
    ],
  );

  // --- Tenant identity and organisation ---
  tenantRepository<ITenantUserRepository>(
    TYPES.TenantUserRepository,
    (tx) => new PostgresTenantUserRepository(tx),
  );
  tenantRepository<IUserMemberships>(
    TYPES.UserMemberships,
    (tx) => new PostgresUserMemberships(tx),
  );
  tenantRepository<ITenantRoles>(TYPES.TenantRoles, (tx) => new PostgresTenantRoles(tx));
  tenantRepository<IOrganisationSettings>(
    TYPES.OrganisationSettings,
    (tx) => new PostgresOrganisationSettings(tx),
  );
  tenantRepository<ITenantSessions>(TYPES.TenantSessions, (tx) => new PostgresTenantSessions(tx));
  container
    .bind<EscalationGuard>(TYPES.EscalationGuard)
    .toResolvedValue(
      (policy: AuthorizationPolicy) => new EscalationGuard(policy),
      [TYPES.AuthorizationPolicy],
    );

  container.bind<TenantSignIn>(TYPES.TenantSignIn).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      tenantContext: ITenantContext,
      users: ITenantUserRepository,
      sessions: ITenantSessions,
      startSession: StartAuthSession,
      passwords: IPasswordHasher,
      otp: IOtpService,
      challenges: IOtpChallengeRepository,
      ids: IIdGenerator,
      organisation: IOrganisationSettings,
      directory: IUserDirectory,
      permissionCache: IPermissionCache,
      notifications: NotificationService,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      clock: IClock,
      logger: ILogger,
    ) =>
      new TenantSignIn({
        unitOfWork,
        tenantContext,
        users,
        sessions,
        startSession,
        passwords,
        issueOtp: new IssueOtpChallenge({
          unitOfWork,
          challenges,
          otp,
          ids,
          clock,
          settings: { ttlMs: auth.otpTtlMinutes * 60_000, maxAttempts: auth.otpMaxAttempts },
        }),
        verifyOtp: new VerifyOtpChallenge({ unitOfWork, challenges, otp, clock }),
        organisation,
        directory,
        permissionCache,
        notifications,
        auditTrail,
        requestContext,
        clock,
        logger,
        lockout: TENANT_LOCKOUT,
        otpTtlMinutes: auth.otpTtlMinutes,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.TenantContext,
      TYPES.TenantUserRepository,
      TYPES.TenantSessions,
      TYPES.StartAuthSession,
      TYPES.PasswordHasher,
      TYPES.OtpService,
      TYPES.OtpChallengeRepository,
      TYPES.IdGenerator,
      TYPES.OrganisationSettings,
      TYPES.UserDirectory,
      TYPES.PermissionCache,
      TYPES.NotificationService,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.Clock,
      TYPES.Logger,
    ],
  );

  container.bind<SessionManagement>(TYPES.SessionManagement).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      sessions: ITenantSessions,
      sessionRepository: IAuthSessionRepository,
      users: ITenantUserRepository,
      memberships: IUserMemberships,
      policy: AuthorizationPolicy,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      clock: IClock,
    ) =>
      new SessionManagement({
        unitOfWork,
        sessions,
        sessionRepository,
        users,
        memberships,
        policy,
        auditTrail,
        requestContext,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.TenantSessions,
      TYPES.AuthSessionRepository,
      TYPES.TenantUserRepository,
      TYPES.UserMemberships,
      TYPES.AuthorizationPolicy,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.Clock,
    ],
  );

  container.bind<UserAdministration>(TYPES.UserAdministration).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      tenantContext: ITenantContext,
      users: ITenantUserRepository,
      memberships: IUserMemberships,
      roles: ITenantRoles,
      branches: IBranches,
      invitations: IUserInvitations,
      sessions: ITenantSessions,
      organisation: IOrganisationSettings,
      directory: IUserDirectory,
      policy: AuthorizationPolicy,
      escalation: EscalationGuard,
      permissionCache: IPermissionCache,
      notifications: NotificationService,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
      mobile: MobileConnect,
    ) =>
      new UserAdministration({
        unitOfWork,
        tenantContext,
        users,
        memberships,
        roles,
        branches,
        invitations,
        sessions,
        organisation,
        directory,
        policy,
        escalation,
        permissionCache,
        notifications,
        auditTrail,
        requestContext,
        ids,
        clock,
        settings: {
          webAppUrl: config.public.webAppUrl,
          invitationTtlMs: USER_INVITATION_TTL_MS,
          appInvitationLink: (slug, token, expiresAt) =>
            mobile.invitationLink(slug, token, expiresAt),
        },
      }),
    [
      TYPES.UnitOfWork,
      TYPES.TenantContext,
      TYPES.TenantUserRepository,
      TYPES.UserMemberships,
      TYPES.TenantRoles,
      TYPES.Branches,
      TYPES.UserInvitations,
      TYPES.TenantSessions,
      TYPES.OrganisationSettings,
      TYPES.UserDirectory,
      TYPES.AuthorizationPolicy,
      TYPES.EscalationGuard,
      TYPES.PermissionCache,
      TYPES.NotificationService,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
      TYPES.MobileConnect,
    ],
  );

  container.bind<RoleAdministration>(TYPES.RoleAdministration).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      roles: ITenantRoles,
      users: ITenantUserRepository,
      memberships: IUserMemberships,
      escalation: EscalationGuard,
      permissionCache: IPermissionCache,
      tenantContext: ITenantContext,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
    ) =>
      new RoleAdministration({
        unitOfWork,
        roles,
        users,
        memberships,
        escalation,
        permissionCache,
        tenantContext,
        auditTrail,
        requestContext,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.TenantRoles,
      TYPES.TenantUserRepository,
      TYPES.UserMemberships,
      TYPES.EscalationGuard,
      TYPES.PermissionCache,
      TYPES.TenantContext,
      TYPES.AuditTrail,
      TYPES.RequestContext,
    ],
  );

  container.bind<OrganisationAdministration>(TYPES.OrganisationAdministration).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      organisation: IOrganisationSettings,
      branches: IBranches,
      policy: AuthorizationPolicy,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      files: FileService,
      storage: IObjectStorage,
      entitlements: BranchEntitlements,
    ) =>
      new OrganisationAdministration({
        entitlements,
        unitOfWork,
        organisation,
        branches,
        policy,
        auditTrail,
        requestContext,
        files,
        storage,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.OrganisationSettings,
      TYPES.Branches,
      TYPES.AuthorizationPolicy,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.TenantFileService,
      TYPES.ObjectStorage,
      TYPES.BranchEntitlements,
    ],
  );

  // --- Billing (subscriptions, entitlements, manual invoices and payments) ---
  platformRepository<IBillingRepository>(
    TYPES.BillingRepository,
    (p) => new PostgresBillingRepository(p),
  );
  container
    .bind<SubscriptionAdministration>(TYPES.SubscriptionAdministration)
    .toResolvedValue(
      (
        billing: IBillingRepository,
        unitOfWork: IPlatformUnitOfWork,
        audit: IPlatformAuditTrail,
        requestContext: IRequestContext,
        ids: IIdGenerator,
        clock: IClock,
      ) =>
        new SubscriptionAdministration({ billing, unitOfWork, audit, requestContext, ids, clock }),
      [
        TYPES.BillingRepository,
        TYPES.PlatformUnitOfWork,
        TYPES.PlatformAuditTrail,
        TYPES.RequestContext,
        TYPES.IdGenerator,
        TYPES.Clock,
      ],
    );
  container.bind<ManualBilling>(TYPES.ManualBilling).toResolvedValue(
    (
      billing: IBillingRepository,
      subscriptions: SubscriptionAdministration,
      lifecycle: TenantLifecycleService,
      unitOfWork: IPlatformUnitOfWork,
      audit: IPlatformAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new ManualBilling({
        billing,
        subscriptions,
        lifecycle,
        unitOfWork,
        audit,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.BillingRepository,
      TYPES.SubscriptionAdministration,
      TYPES.TenantLifecycleService,
      TYPES.PlatformUnitOfWork,
      TYPES.PlatformAuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container
    .bind<BranchEntitlements>(TYPES.BranchEntitlements)
    .toResolvedValue(
      (
        billing: IBillingRepository,
        subscriptions: SubscriptionAdministration,
        unitOfWork: IPlatformUnitOfWork,
        clock: IClock,
      ) => new BranchEntitlements({ billing, subscriptions, unitOfWork, clock }),
      [
        TYPES.BillingRepository,
        TYPES.SubscriptionAdministration,
        TYPES.PlatformUnitOfWork,
        TYPES.Clock,
      ],
    );
  container
    .bind<TenantBilling>(TYPES.TenantBilling)
    .toResolvedValue(
      (
        subscriptions: SubscriptionAdministration,
        billing: ManualBilling,
        tenantContext: ITenantContext,
      ) => new TenantBilling({ subscriptions, billing, tenantContext }),
      [TYPES.SubscriptionAdministration, TYPES.ManualBilling, TYPES.TenantContext],
    );

  // --- Mobile connect (signed links, QR codes, app-link metadata) ---
  container.bind<IConnectLinkSigner>(TYPES.ConnectLinkSigner).toResolvedValue(() => {
    const pem = config.mobile.connectPrivateKeyPem;
    if (pem !== null) return Ed25519ConnectLinkSigner.fromPem(pem);
    // Config refuses a missing key in production; locally a fixed development key is used.
    return Ed25519ConnectLinkSigner.fromSeed(DEVELOPMENT_KEY_SEED);
  });
  container.bind<MobileConnect>(TYPES.MobileConnect).toResolvedValue(
    (signer: IConnectLinkSigner, directory: ITenantDirectory, clock: IClock) =>
      new MobileConnect({
        signer,
        qr: new QrcodeSvgRenderer(),
        directory,
        clock,
        settings: {
          apiBaseUrl: config.mobile.apiBaseUrl,
          linkBaseUrl: config.mobile.linkBaseUrl,
          scheme: config.mobile.scheme,
          allowedHosts: new HostAllowList(config.mobile.allowedHosts),
          android: config.mobile.android,
          ios: config.mobile.ios,
          minVersion: config.mobile.minVersion,
          latestVersion: config.mobile.latestVersion,
        },
      }),
    [TYPES.ConnectLinkSigner, TYPES.TenantDirectory, TYPES.Clock],
  );

  // --- Files (object storage, tenant and platform file records) ---
  container
    .bind<S3ObjectStorage>(TYPES.ObjectStorage)
    .toResolvedValue(() => new S3ObjectStorage(config.storage))
    .onDeactivation((storage) => storage.destroy());
  container
    .bind<IFileRepository>(TYPES.TenantFileRepository)
    .toResolvedValue(
      (tx: PostgresTransactionContext) => new PostgresFileRepository(() => tx.current(), "files"),
      [TYPES.PostgresTransactionContext],
    );
  container
    .bind<IFileRepository>(TYPES.PlatformFileRepository)
    .toResolvedValue(
      (platformDb: PlatformDb) => new PostgresFileRepository(() => platformDb, "platform_files"),
      [TYPES.PlatformDb],
    );
  container.bind<FileService>(TYPES.TenantFileService).toResolvedValue(
    (
      files: IFileRepository,
      storage: IObjectStorage,
      unitOfWork: IUnitOfWork,
      tenantContext: ITenantContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new FileService({
        scope: "tenant",
        files,
        storage,
        unitOfWork,
        keyPrefix: () => `tenants/${tenantContext.currentTenantId().value}`,
        ids,
        clock,
      }),
    [
      TYPES.TenantFileRepository,
      TYPES.ObjectStorage,
      TYPES.UnitOfWork,
      TYPES.TenantContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<FileService>(TYPES.PlatformFileService).toResolvedValue(
    (
      files: IFileRepository,
      storage: IObjectStorage,
      unitOfWork: IPlatformUnitOfWork,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new FileService({
        scope: "platform",
        files,
        storage,
        unitOfWork,
        keyPrefix: () => "platform",
        ids,
        clock,
      }),
    [
      TYPES.PlatformFileRepository,
      TYPES.ObjectStorage,
      TYPES.PlatformUnitOfWork,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container
    .bind<TenantFileUploads>(TYPES.TenantFileUploads)
    .toResolvedValue(
      (files: FileService, policy: AuthorizationPolicy) => new TenantFileUploads({ files, policy }),
      [TYPES.TenantFileService, TYPES.AuthorizationPolicy],
    );
  container.bind<ApplicationDocuments>(TYPES.ApplicationDocuments).toResolvedValue(
    (applications: ITenantApplicationRepository, files: FileService) =>
      new ApplicationDocuments({
        applications,
        documents: new OwnedDocuments(
          files,
          "application_document",
          APPLICATION_OWNER,
          MAX_APPLICATION_DOCUMENTS,
        ),
      }),
    [TYPES.TenantApplicationRepository, TYPES.PlatformFileService],
  );
  container.bind<PartnerDocuments>(TYPES.PartnerDocuments).toResolvedValue(
    (
      partners: IPartnerRepository,
      files: FileService,
      audit: IPlatformAuditTrail,
      requestContext: IRequestContext,
    ) =>
      new PartnerDocuments({
        partners,
        documents: new OwnedDocuments(
          files,
          "partner_document",
          PARTNER_OWNER,
          MAX_PARTNER_DOCUMENTS,
        ),
        audit,
        requestContext,
      }),
    [
      TYPES.PartnerRepository,
      TYPES.PlatformFileService,
      TYPES.PlatformAuditTrail,
      TYPES.RequestContext,
    ],
  );

  // --- HTTP ---
  container.bind<AccessGuard>(TYPES.AccessGuard).toResolvedValue(
    (
      authenticate: AuthenticateTenantRequest,
      resolveTenant: ResolveTenant,
      authorization: AuthorizationPolicy,
      tenantContext: ITenantContext,
      staffSessions: StaffSessions,
      clock: IClock,
    ) =>
      new AccessGuard({
        authenticate,
        resolveTenant,
        authorization,
        tenantContext,
        staffSessions,
        clock,
      }),
    [
      TYPES.AuthenticateTenantRequest,
      TYPES.ResolveTenant,
      TYPES.AuthorizationPolicy,
      TYPES.TenantContext,
      TYPES.StaffSessions,
      TYPES.Clock,
    ],
  );
  // --- Console MVP: dashboard, tenant 360, notes & tags, data operations, health ---
  platformRepository<IConsoleTenantQueries>(
    TYPES.ConsoleTenantQueries,
    (p) => new PostgresConsoleTenantQueries(p),
  );
  platformRepository<ITenantNotes>(TYPES.TenantNotes, (p) => new PostgresTenantNotes(p));
  platformRepository<ITenantTags>(TYPES.TenantTags, (p) => new PostgresTenantTags(p));
  platformRepository<IDataOperationsQueries>(
    TYPES.DataOperationsQueries,
    (p) => new PostgresDataOperationsQueries(p),
  );
  platformRepository<ISystemProbes>(
    TYPES.SystemProbes,
    (p) => new PostgresSystemProbes(p, APP_VERSION),
  );
  container
    .bind<ITenantUsage>(TYPES.TenantUsage)
    .toResolvedValue(
      (pools: TenantConnectionPools) => new PostgresTenantUsage(pools),
      [TYPES.TenantConnectionPools],
    );
  container
    .bind<ConsoleDashboard>(TYPES.ConsoleDashboard)
    .toResolvedValue(
      (queries: IConsoleTenantQueries, clock: IClock, billing: IBillingRepository) =>
        new ConsoleDashboard({ queries, clock, billing }),
      [TYPES.ConsoleTenantQueries, TYPES.Clock, TYPES.BillingRepository],
    );
  container
    .bind<TenantAccounts>(TYPES.TenantAccounts)
    .toResolvedValue(
      (
        queries: IConsoleTenantQueries,
        usage: ITenantUsage,
        directory: ITenantDirectory,
        clock: IClock,
        logger: ILogger,
      ) => new TenantAccounts({ queries, usage, directory, clock, logger }),
      [
        TYPES.ConsoleTenantQueries,
        TYPES.TenantUsage,
        TYPES.TenantDirectory,
        TYPES.Clock,
        TYPES.Logger,
      ],
    );
  container.bind<TenantNotesAndTags>(TYPES.TenantNotesAndTags).toResolvedValue(
    (
      notes: ITenantNotes,
      tags: ITenantTags,
      directory: ITenantDirectory,
      unitOfWork: IPlatformUnitOfWork,
      audit: IPlatformAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new TenantNotesAndTags({
        notes,
        tags,
        directory,
        unitOfWork,
        audit,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.TenantNotes,
      TYPES.TenantTags,
      TYPES.TenantDirectory,
      TYPES.PlatformUnitOfWork,
      TYPES.PlatformAuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<DataOperationsConsole>(TYPES.DataOperationsConsole).toResolvedValue(
    (queries: IDataOperationsQueries, clock: IClock, sets: MigrationSets) =>
      new DataOperationsConsole({
        queries,
        clock,
        latest: { platform: sets.platform.latestVersion, tenant: sets.tenant.latestVersion },
      }),
    [TYPES.DataOperationsQueries, TYPES.Clock, TYPES.MigrationSets],
  );
  container
    .bind<SystemHealthSummary>(TYPES.SystemHealthSummary)
    .toResolvedValue(
      (probes: ISystemProbes, dataOperations: DataOperationsConsole, clock: IClock) =>
        new SystemHealthSummary({ probes, dataOperations, clock }),
      [TYPES.SystemProbes, TYPES.DataOperationsConsole, TYPES.Clock],
    );
  container
    .bind<AuditLogExport>(TYPES.AuditLogExport)
    .toResolvedValue(
      (audit: IPlatformAuditTrail, requestContext: IRequestContext) =>
        new AuditLogExport({ audit, requestContext }),
      [TYPES.PlatformAuditTrail, TYPES.RequestContext],
    );

  container
    .bind<IReadinessCheck[]>(TYPES.ReadinessChecks)
    .toResolvedValue(
      (pool: pg.Pool) => [new DatabaseReadinessCheck(pool)],
      [TYPES.PlatformDatabasePool],
    );

  container
    .bind<ReadinessService>(TYPES.ReadinessService)
    .toResolvedValue(
      (checks: IReadinessCheck[], logger: ILogger) => new ReadinessService(checks, logger),
      [TYPES.ReadinessChecks, TYPES.Logger],
    );

  container
    .bind<HealthController>(TYPES.HealthController)
    .toResolvedValue(
      (readiness: ReadinessService) => new HealthController(readiness),
      [TYPES.ReadinessService],
    );

  container.bind<ApiRoute[]>(TYPES.ApiRoutes).toResolvedValue(
    (
      health: HealthController,
      signIn: StaffSignIn,
      sessions: StaffSessions,
      administration: StaffAdministration,
      approvals: ApprovalWorkflow,
      audit: IPlatformAuditTrail,
      signup: ApplicationSignup,
      review: ApplicationReview,
      provisioningConsole: ProvisioningConsole,
      acceptInvitation: AcceptUserInvitation,
      lifecycle: TenantLifecycleService,
      branches: BranchLifecycle,
      publicConfig: TenantPublicConfig,
      tenantContext: ITenantContext,
      directory: ITenantDirectory,
      tenantSignIn: TenantSignIn,
      refresh: RefreshAuthSession,
      revoke: RevokeAuthSession,
      sessionManagement: SessionManagement,
      users: UserAdministration,
      roles: RoleAdministration,
      organisation: OrganisationAdministration,
      dashboard: ConsoleDashboard,
      tenantAccounts: TenantAccounts,
      notes: TenantNotesAndTags,
      dataOperations: DataOperationsConsole,
      systemHealth: SystemHealthSummary,
      auditExport: AuditLogExport,
      partnerAdministration: PartnerAdministration,
      partnerPortal: PartnerPortal,
      tenantFiles: TenantFileUploads,
      applicationDocuments: ApplicationDocuments,
      partnerDocuments: PartnerDocuments,
      mobile: MobileConnect,
      tenantBilling: TenantBilling,
      subscriptionAdministration: SubscriptionAdministration,
      manualBilling: ManualBilling,
    ) => {
      const routes = [
        ...healthRoutes(health),
        ...sessionRoutes(),
        ...platformRoutes({ signIn, sessions, administration, approvals, audit }),
        ...applicationRoutes({ signup, review }),
        ...provisioningRoutes({ console: provisioningConsole, acceptInvitation }),
        ...lifecycleRoutes({ lifecycle, branches, publicConfig, tenantContext, directory }),
        ...consoleRoutes({
          dashboard,
          tenants: tenantAccounts,
          notes,
          dataOperations,
          health: systemHealth,
          auditExport,
        }),
        ...partnerRoutes({ administration: partnerAdministration, portal: partnerPortal }),
        ...fileRoutes({ tenantFiles, organisation, applicationDocuments, partnerDocuments }),
        ...mobileRoutes(mobile),
        ...billingRoutes({
          tenantBilling,
          subscriptions: subscriptionAdministration,
          billing: manualBilling,
        }),
        ...identityRoutes({
          signIn: tenantSignIn,
          refresh,
          revoke,
          sessions: sessionManagement,
          users,
          roles,
          organisation,
        }),
      ];
      return config.http.exposeOpenApi
        ? [...routes, ...openApiRoutes(routes, OPENAPI_INFO)]
        : routes;
    },
    [
      TYPES.HealthController,
      TYPES.StaffSignIn,
      TYPES.StaffSessions,
      TYPES.StaffAdministration,
      TYPES.ApprovalWorkflow,
      TYPES.PlatformAuditTrail,
      TYPES.ApplicationSignup,
      TYPES.ApplicationReview,
      TYPES.ProvisioningConsole,
      TYPES.AcceptUserInvitation,
      TYPES.TenantLifecycleService,
      TYPES.BranchLifecycle,
      TYPES.TenantPublicConfig,
      TYPES.TenantContext,
      TYPES.TenantDirectory,
      TYPES.TenantSignIn,
      TYPES.RefreshAuthSession,
      TYPES.RevokeAuthSession,
      TYPES.SessionManagement,
      TYPES.UserAdministration,
      TYPES.RoleAdministration,
      TYPES.OrganisationAdministration,
      TYPES.ConsoleDashboard,
      TYPES.TenantAccounts,
      TYPES.TenantNotesAndTags,
      TYPES.DataOperationsConsole,
      TYPES.SystemHealthSummary,
      TYPES.AuditLogExport,
      TYPES.PartnerAdministration,
      TYPES.PartnerPortal,
      TYPES.TenantFileUploads,
      TYPES.ApplicationDocuments,
      TYPES.PartnerDocuments,
      TYPES.MobileConnect,
      TYPES.TenantBilling,
      TYPES.SubscriptionAdministration,
      TYPES.ManualBilling,
    ],
  );

  container
    .bind<Express>(TYPES.HttpApp)
    .toResolvedValue(
      (
        logger: ILogger,
        requestContext: IRequestContext,
        routes: ApiRoute[],
        accessGuard: AccessGuard,
      ) => createApp({ http: config.http, logger, requestContext, routes, accessGuard }),
      [TYPES.Logger, TYPES.RequestContext, TYPES.ApiRoutes, TYPES.AccessGuard],
    );

  return container;
}

/** Releases every resolved resource (database pools) through their deactivation handlers. */
export async function disposeContainer(container: Container): Promise<void> {
  await container.unbindAllAsync();
}
