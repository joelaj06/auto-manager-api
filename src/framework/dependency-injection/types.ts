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
  PermissionCache: Symbol.for("IPermissionCache"),

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

  // Platform console (staff)
  PlatformTransactionContext: Symbol.for("PlatformTransactionContext"),
  PlatformDb: Symbol.for("PlatformDb"),
  PlatformUnitOfWork: Symbol.for("IPlatformUnitOfWork"),
  StaffAccountRepository: Symbol.for("IStaffAccountRepository"),
  PlatformRoles: Symbol.for("IPlatformRoles"),
  StaffInvitations: Symbol.for("IStaffInvitations"),
  PlatformSessions: Symbol.for("IPlatformSessions"),
  ApprovalRequestRepository: Symbol.for("IApprovalRequestRepository"),
  PlatformAuditTrail: Symbol.for("IPlatformAuditTrail"),
  KnownDevices: Symbol.for("IKnownDevices"),
  Totp: Symbol.for("ITotp"),
  SecretBox: Symbol.for("ISecretBox"),
  StaffChallenges: Symbol.for("IStaffChallenges"),
  StaffSessions: Symbol.for("StaffSessions"),
  StaffSignIn: Symbol.for("StaffSignIn"),
  ApprovalWorkflow: Symbol.for("ApprovalWorkflow"),
  StaffAdministration: Symbol.for("StaffAdministration"),

  // Tenant applications (signup)
  TenantApplicationRepository: Symbol.for("ITenantApplicationRepository"),
  ApplicationEvents: Symbol.for("IApplicationEvents"),
  ApplicationLookups: Symbol.for("IApplicationLookups"),
  SmsSender: Symbol.for("ISmsSender"),
  ApplicationSignup: Symbol.for("ApplicationSignup"),
  ApplicationReview: Symbol.for("ApplicationReview"),

  // Provisioning and tenant catalogue
  PermissionCatalogueSource: Symbol.for("IPermissionCatalogueSource"),
  TenantProvisioning: Symbol.for("ITenantProvisioning"),
  TenantSeeder: Symbol.for("ITenantSeeder"),
  UserInvitations: Symbol.for("IUserInvitations"),
  TenantUserAccounts: Symbol.for("ITenantUserAccounts"),
  UserDirectory: Symbol.for("IUserDirectory"),
  TenantSchemaUpdater: Symbol.for("ITenantSchemaUpdater"),
  OrphanDatabases: Symbol.for("IOrphanDatabases"),
  ProvisioningJobHandlers: Symbol.for("ProvisioningJobHandlers"),
  ProvisioningConsole: Symbol.for("ProvisioningConsole"),
  AcceptUserInvitation: Symbol.for("AcceptUserInvitation"),

  // Tenant and branch lifecycle
  TenantLifecycleRepository: Symbol.for("ITenantLifecycleRepository"),
  TenantSessionRevoker: Symbol.for("ITenantSessionRevoker"),
  Branches: Symbol.for("IBranches"),
  BranchDeactivationChecks: Symbol.for("IBranchDeactivationCheck[]"),
  TenantPublicProfiles: Symbol.for("ITenantPublicProfiles"),
  OrganisationReader: Symbol.for("IOrganisationReader"),
  TenantLifecycleService: Symbol.for("TenantLifecycleService"),
  BranchLifecycle: Symbol.for("BranchLifecycle"),
  TenantPublicConfig: Symbol.for("TenantPublicConfig"),

  // Tenant identity and organisation
  TenantUserRepository: Symbol.for("ITenantUserRepository"),
  UserMemberships: Symbol.for("IUserMemberships"),
  TenantRoles: Symbol.for("ITenantRoles"),
  OrganisationSettings: Symbol.for("IOrganisationSettings"),
  TenantSessions: Symbol.for("ITenantSessions"),
  EscalationGuard: Symbol.for("EscalationGuard"),
  TenantSignIn: Symbol.for("TenantSignIn"),
  SessionManagement: Symbol.for("SessionManagement"),
  UserAdministration: Symbol.for("UserAdministration"),
  RoleAdministration: Symbol.for("RoleAdministration"),
  OrganisationAdministration: Symbol.for("OrganisationAdministration"),

  // Console MVP (P1-6)
  ConsoleTenantQueries: Symbol.for("IConsoleTenantQueries"),
  TenantUsage: Symbol.for("ITenantUsage"),
  TenantNotes: Symbol.for("ITenantNotes"),
  TenantTags: Symbol.for("ITenantTags"),
  DataOperationsQueries: Symbol.for("IDataOperationsQueries"),
  SystemProbes: Symbol.for("ISystemProbes"),
  ConsoleDashboard: Symbol.for("ConsoleDashboard"),
  TenantAccounts: Symbol.for("TenantAccounts"),
  TenantNotesAndTags: Symbol.for("TenantNotesAndTags"),
  DataOperationsConsole: Symbol.for("DataOperationsConsole"),
  SystemHealthSummary: Symbol.for("SystemHealthSummary"),
  AuditLogExport: Symbol.for("AuditLogExport"),

  // Reseller programme (P1-7)
  PartnerRepository: Symbol.for("IPartnerRepository"),
  PartnerQueries: Symbol.for("IPartnerQueries"),
  PartnerAttributions: Symbol.for("IPartnerAttributions"),
  PartnerAdministration: Symbol.for("PartnerAdministration"),
  PartnerPortal: Symbol.for("PartnerPortal"),

  // Files (P1-8)
  ObjectStorage: Symbol.for("IObjectStorage"),
  TenantFileRepository: Symbol.for("TenantFileRepository"),
  PlatformFileRepository: Symbol.for("PlatformFileRepository"),
  TenantFileService: Symbol.for("TenantFileService"),
  PlatformFileService: Symbol.for("PlatformFileService"),
  TenantFileUploads: Symbol.for("TenantFileUploads"),
  ApplicationDocuments: Symbol.for("ApplicationDocuments"),
  PartnerDocuments: Symbol.for("PartnerDocuments"),

  // Mobile connect (P1-9)
  ConnectLinkSigner: Symbol.for("IConnectLinkSigner"),
  MobileConnect: Symbol.for("MobileConnect"),

  // Billing (P1-10)
  BillingRepository: Symbol.for("IBillingRepository"),
  SubscriptionAdministration: Symbol.for("SubscriptionAdministration"),
  ManualBilling: Symbol.for("ManualBilling"),
  BranchEntitlements: Symbol.for("BranchEntitlements"),
  TenantBilling: Symbol.for("TenantBilling"),

  // Reference data and settings (P2-1)
  ReferenceData: Symbol.for("IReferenceData"),
  TenantReferenceData: Symbol.for("ITenantReferenceData"),
  CurrencySettingsService: Symbol.for("CurrencySettingsService"),
  TaxAdministration: Symbol.for("TaxAdministration"),
  FxRateBook: Symbol.for("FxRateBook"),
  ExpenseCategoryAdministration: Symbol.for("ExpenseCategoryAdministration"),
  VehicleCatalogue: Symbol.for("VehicleCatalogue"),
  DocumentNumbering: Symbol.for("DocumentNumbering"),
});
