import type { Express } from "express";
import { Container } from "inversify";
import type pg from "pg";
import { HealthController } from "../../adapters/controllers/HealthController.js";
import type { ApiRoute } from "../../adapters/routes/ApiRoute.js";
import { healthRoutes } from "../../adapters/routes/healthRoutes.js";
import { openApiRoutes } from "../../adapters/routes/openApiRoutes.js";
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
import { createApp } from "../express/createApp.js";
import { JsonLogger, jsonSink } from "../logger/JsonLogger.js";
import { prettySink } from "../logger/prettySink.js";
import { TYPES } from "./types.js";

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
 * Resources (pools) are released through `onDeactivation`; call `disposeContainer` on shutdown.
 */
export function createContainer(config: AppConfig, migrations: MigrationSets): Container {
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
        bindings: { service: "autoforce-api" },
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
      ) => new PostgresTenantUnitOfWork(tenantContext, pools, tx),
      [TYPES.TenantContext, TYPES.TenantConnectionPools, TYPES.PostgresTransactionContext],
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

  container
    .bind<IOutbox>(TYPES.Outbox)
    .toResolvedValue(
      (tx: PostgresTransactionContext) => new PostgresOutbox(tx),
      [TYPES.PostgresTransactionContext],
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

  // --- HTTP ---
  container
    .bind<AccessGuard>(TYPES.AccessGuard)
    .toResolvedValue(
      (
        authenticate: AuthenticateTenantRequest,
        resolveTenant: ResolveTenant,
        authorization: AuthorizationPolicy,
        tenantContext: ITenantContext,
      ) => new AccessGuard({ authenticate, resolveTenant, authorization, tenantContext }),
      [
        TYPES.AuthenticateTenantRequest,
        TYPES.ResolveTenant,
        TYPES.AuthorizationPolicy,
        TYPES.TenantContext,
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
    (health: HealthController) => {
      const routes = [...healthRoutes(health)];
      return config.http.exposeOpenApi
        ? [...routes, ...openApiRoutes(routes, OPENAPI_INFO)]
        : routes;
    },
    [TYPES.HealthController],
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
