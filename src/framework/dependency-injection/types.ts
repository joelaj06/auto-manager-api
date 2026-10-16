/** Injection tokens for the Inversify container (framework layer only). */
export const TYPES = Object.freeze({
  Config: Symbol.for("Config"),
  MigrationSets: Symbol.for("MigrationSets"),

  // Database infrastructure
  PostgresConnectionFactory: Symbol.for("PostgresConnectionFactory"),
  TenantDatabaseNaming: Symbol.for("TenantDatabaseNaming"),
  PlatformDatabasePool: Symbol.for("PlatformDatabasePool"),
  TenantConnectionPools: Symbol.for("TenantConnectionPools"),
  PostgresTransactionContext: Symbol.for("PostgresTransactionContext"),
  MigrationRunner: Symbol.for("MigrationRunner"),

  // Observability and HTTP
  Logger: Symbol.for("ILogger"),
  RequestContext: Symbol.for("IRequestContext"),
  ReadinessChecks: Symbol.for("IReadinessCheck[]"),
  ReadinessService: Symbol.for("ReadinessService"),
  HealthController: Symbol.for("HealthController"),
  ApiRoutes: Symbol.for("ApiRoute[]"),
  HttpApp: Symbol.for("HttpApp"),

  // Application ports
  TenantContext: Symbol.for("ITenantContext"),
  UnitOfWork: Symbol.for("IUnitOfWork"),
  SequenceGenerator: Symbol.for("ISequenceGenerator"),
  AuditTrail: Symbol.for("IAuditTrail"),
  Outbox: Symbol.for("IOutbox"),
  TenantDatabaseProvisioner: Symbol.for("ITenantDatabaseProvisioner"),
  Clock: Symbol.for("IClock"),
  IdGenerator: Symbol.for("IIdGenerator"),
  PasswordHasher: Symbol.for("IPasswordHasher"),
  AccessTokenService: Symbol.for("IAccessTokenService"),
  RefreshTokenService: Symbol.for("IRefreshTokenService"),
  OtpService: Symbol.for("IOtpService"),
  TenantDirectory: Symbol.for("ITenantDirectory"),
  PermissionResolver: Symbol.for("IPermissionResolver"),

  // Repositories
  AuthSessionRepository: Symbol.for("IAuthSessionRepository"),
  OtpChallengeRepository: Symbol.for("IOtpChallengeRepository"),

  // Authorization and auth use cases
  AuthorizationPolicy: Symbol.for("AuthorizationPolicy"),
  StartAuthSession: Symbol.for("StartAuthSession"),
  RefreshAuthSession: Symbol.for("RefreshAuthSession"),
  RevokeAuthSession: Symbol.for("RevokeAuthSession"),
  AuthenticateTenantRequest: Symbol.for("AuthenticateTenantRequest"),
  ResolveTenant: Symbol.for("ResolveTenant"),
  IssueOtpChallenge: Symbol.for("IssueOtpChallenge"),
  VerifyOtpChallenge: Symbol.for("VerifyOtpChallenge"),
  AccessGuard: Symbol.for("AccessGuard"),

  // Background jobs, events and notifications
  JobQueue: Symbol.for("IJobQueue"),
  OutboxStore: Symbol.for("IOutboxStore"),
  ProcessedMessages: Symbol.for("IProcessedMessages"),
  TenantRetention: Symbol.for("ITenantRetention"),
  TenantRoster: Symbol.for("ITenantRoster"),
  TenantScheduleLedger: Symbol.for("ITenantScheduleLedger"),
  EventHandlers: Symbol.for("IEventHandler[]"),
  EventHandlerRegistry: Symbol.for("EventHandlerRegistry"),
  EmailDeliveries: Symbol.for("IEmailDeliveries"),
  EmailSender: Symbol.for("IEmailSender"),
  NotificationService: Symbol.for("NotificationService"),
  JobHandlers: Symbol.for("IJobHandler[]"),
  JobWorker: Symbol.for("JobWorker"),
});
