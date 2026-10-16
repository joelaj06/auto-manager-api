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
import { NoUsersPermissionResolver } from "../../infrastructure/authorization/NoUsersPermissionResolver.js";
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
import { platformRoutes } from "../../adapters/routes/platformRoutes.js";
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
      ): IJobHandler[] => [
        new DrainOutbox({ unitOfWork, outbox, handlers, queue, clock }),
        new SweepOutboxes({ roster, queue }),
        new DeliverEvent({ unitOfWork, processed, handlers, logger }),
        new RunTenantSchedules({ roster, ledger, clock, logger }),
        new RunDailyMaintenance({ unitOfWork, retention, clock, logger }),
        new SendQueuedEmail({ deliveries, sender, clock, logger }),
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
    .toResolvedValue(() => new CachingPermissionResolver(new NoUsersPermissionResolver()));

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
    ) =>
      new StaffSessions({
        unitOfWork,
        accounts,
        roles,
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
    ) => {
      const routes = [
        ...healthRoutes(health),
        ...sessionRoutes(),
        ...platformRoutes({ signIn, sessions, administration, approvals, audit }),
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
