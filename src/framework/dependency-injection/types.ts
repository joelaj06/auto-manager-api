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
});
