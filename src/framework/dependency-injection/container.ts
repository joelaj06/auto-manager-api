import { workpayRoutes } from "../../adapters/routes/workpayRoutes.js";
import { rentalRoutes } from "../../adapters/routes/rentalRoutes.js";
import type { IVehicleBlocks } from "../../application/ports/IVehicleBlocks.js";
import type { IRentalBookings } from "../../application/ports/IRentalBookings.js";
import type {
  IRentalInspections,
  IVehicleDamages,
} from "../../application/ports/IRentalInspections.js";
import type { IRentalRates } from "../../application/ports/IRentalRates.js";
import type { IRentalReporting } from "../../application/ports/IRentalReporting.js";
import {
  RentalNotifications,
  RunRentalReminders,
  SweepRentalReminders,
} from "../../application/use-cases/rentals/RentalNotifications.js";
import { RentalReports } from "../../application/use-cases/rentals/RentalReports.js";
import { PostgresRentalReporting } from "../../infrastructure/rentals/PostgresRentalReporting.js";
import { RentalAgreements } from "../../application/use-cases/rentals/RentalAgreements.js";
import { RentalAvailability } from "../../application/use-cases/rentals/RentalAvailability.js";
import type { IssuedDocumentProps } from "../../domain/documents/IssuedDocument.js";
import { RentalBookings } from "../../application/use-cases/rentals/RentalBookings.js";
import {
  BOOKING_PHOTO_OWNER,
  RentalInspections,
} from "../../application/use-cases/rentals/RentalInspections.js";
import { VehicleDamages } from "../../application/use-cases/rentals/VehicleDamages.js";
import {
  DEPOSIT_SOURCE,
  RentalAccounts,
} from "../../application/use-cases/rentals/RentalAccounts.js";
import { RentalQuotes } from "../../application/use-cases/rentals/RentalQuotes.js";
import { RentalRateAdministration } from "../../application/use-cases/rentals/RentalRateAdministration.js";
import { PostgresVehicleBlocks } from "../../infrastructure/rentals/PostgresVehicleBlocks.js";
import { PostgresRentalBookings } from "../../infrastructure/rentals/PostgresRentalBookings.js";
import {
  PostgresRentalInspections,
  PostgresVehicleDamages,
} from "../../infrastructure/rentals/PostgresRentalInspections.js";
import { rentalBookingRoutes } from "../../adapters/routes/rentalBookingRoutes.js";
import { vehicleDamageRoutes } from "../../adapters/routes/vehicleDamageRoutes.js";
import { rentalAccountRoutes } from "../../adapters/routes/rentalAccountRoutes.js";
import { rentalReportRoutes } from "../../adapters/routes/rentalReportRoutes.js";
import { maintenanceRoutes } from "../../adapters/routes/maintenanceRoutes.js";
import type { IServicePlans } from "../../application/ports/IServicePlans.js";
import { ServicePlans } from "../../application/use-cases/maintenance/ServicePlans.js";
import { ServiceSchedule } from "../../application/use-cases/maintenance/ServiceSchedule.js";
import { PostgresServicePlans } from "../../infrastructure/maintenance/PostgresServicePlans.js";
import { workOrderRoutes } from "../../adapters/routes/workOrderRoutes.js";
import type { IWorkOrders } from "../../application/ports/IWorkOrders.js";
import { WorkOrders } from "../../application/use-cases/maintenance/WorkOrders.js";
import { PostgresWorkOrders } from "../../infrastructure/maintenance/PostgresWorkOrders.js";
import { partRoutes } from "../../adapters/routes/partRoutes.js";
import type { IParts } from "../../application/ports/IParts.js";
import { PartsInventory } from "../../application/use-cases/maintenance/PartsInventory.js";
import { PostgresParts } from "../../infrastructure/maintenance/PostgresParts.js";
import { incidentRoutes } from "../../adapters/routes/incidentRoutes.js";
import type { IIncidents } from "../../application/ports/IIncidents.js";
import { FuelAnomalies } from "../../application/use-cases/incidents/FuelAnomalies.js";
import { Incidents } from "../../application/use-cases/incidents/Incidents.js";
import { TrafficOffences } from "../../application/use-cases/incidents/TrafficOffences.js";
import { PostgresIncidents } from "../../infrastructure/incidents/PostgresIncidents.js";
import { maintenanceReportRoutes } from "../../adapters/routes/maintenanceReportRoutes.js";
import { payablesRoutes } from "../../adapters/routes/payablesRoutes.js";
import { purchaseRoutes } from "../../adapters/routes/purchaseRoutes.js";
import type { IPurchases } from "../../application/ports/IPurchases.js";
import { PurchaseAlerts } from "../../application/use-cases/purchases/PurchaseAlerts.js";
import { PurchaseCostHook, Purchases } from "../../application/use-cases/purchases/Purchases.js";
import { PostgresPurchases } from "../../infrastructure/purchases/PostgresPurchases.js";
import type { IDealerStock } from "../../application/ports/IDealerStock.js";
import { DealerStock } from "../../application/use-cases/dealer/DealerStock.js";
import { StockAlerts } from "../../application/use-cases/dealer/StockAlerts.js";
import { PostgresDealerStock } from "../../infrastructure/dealer/PostgresDealerStock.js";
import { dealerStockRoutes } from "../../adapters/routes/dealerStockRoutes.js";
import type { IMaintenanceReporting } from "../../application/ports/IMaintenanceReporting.js";
import { MaintenanceAlerts } from "../../application/use-cases/maintenance/MaintenanceAlerts.js";
import { MaintenanceReports } from "../../application/use-cases/maintenance/MaintenanceReports.js";
import {
  SupplierPayables,
  SupplierPaymentListener,
} from "../../application/use-cases/payables/SupplierPayables.js";
import type { IPayables } from "../../application/ports/IPayables.js";
import { PostgresPayables } from "../../infrastructure/payables/PostgresPayables.js";
import { PostgresMaintenanceReporting } from "../../infrastructure/maintenance/PostgresMaintenanceReporting.js";
import { PostgresRentalRates } from "../../infrastructure/rentals/PostgresRentalRates.js";
import { BillingDocuments } from "../../application/use-cases/billing/BillingDocuments.js";
import type { IPaymentGateway } from "../../application/ports/IPaymentGateway.js";
import { GatewayBilling } from "../../application/use-cases/billing/GatewayBilling.js";
import { GatewayReconciliation } from "../../application/use-cases/billing/GatewayReconciliation.js";
import { BillingAutomation } from "../../application/use-cases/billing/BillingAutomation.js";
import { BillingExtensions } from "../../application/use-cases/billing/BillingExtensions.js";
import { BillingNotices } from "../../application/use-cases/billing/BillingNotices.js";
import type { IBillingAutomationRepository } from "../../domain/repositories/IBillingAutomationRepository.js";
import { PostgresBillingAutomationRepository } from "../../infrastructure/billing/PostgresBillingAutomationRepository.js";
import type { IGatewayRepository } from "../../domain/repositories/IGatewayRepository.js";
import { FakePaymentGateway } from "../../infrastructure/billing/FakePaymentGateway.js";
import { PaystackGateway } from "../../infrastructure/billing/PaystackGateway.js";
import { PostgresGatewayRepository } from "../../infrastructure/billing/PostgresGatewayRepository.js";
import type { IIntegrityChecks } from "../../application/ports/IIntegrityChecks.js";
import { PostgresIntegrityChecks } from "../../infrastructure/integrity/PostgresIntegrityChecks.js";
import type {
  IWorkPayAgreementRepository,
  IWorkPayLifecycleRecords,
  IWorkPaySchedule,
  IWorkPaySettingsStore,
  IWorkPayTransfers,
} from "../../application/ports/IWorkPayRecords.js";
import { WorkPayAgreements } from "../../application/use-cases/workpay/WorkPayAgreements.js";
import { WorkPayArrears } from "../../application/use-cases/workpay/WorkPayArrears.js";
import { WorkPayCollections } from "../../application/use-cases/workpay/WorkPayCollections.js";
import { WorkPayDriverCosts } from "../../application/use-cases/workpay/WorkPayDriverCosts.js";
import { WorkPayLifecycle } from "../../application/use-cases/workpay/WorkPayLifecycle.js";
import { WorkPayTransfers } from "../../application/use-cases/workpay/WorkPayTransfers.js";
import { WorkPayNotifications } from "../../application/use-cases/workpay/WorkPayNotifications.js";
import { WorkPayReports } from "../../application/use-cases/workpay/WorkPayReports.js";
import type { IWorkPayReporting } from "../../application/ports/IWorkPayReporting.js";
import { PostgresWorkPayReporting } from "../../infrastructure/workpay/PostgresWorkPayReporting.js";
import { WorkPayDeposits } from "../../application/use-cases/workpay/WorkPayDeposits.js";
import { WorkPaySettingsService } from "../../application/use-cases/workpay/WorkPaySettingsService.js";
import {
  PostgresWorkPayAgreements,
  PostgresWorkPayLifecycle,
  PostgresWorkPaySchedule,
  PostgresWorkPaySettingsStore,
  PostgresWorkPayTransfers,
} from "../../infrastructure/workpay/PostgresWorkPay.js";
import { documentRoutes } from "../../adapters/routes/documentRoutes.js";
import type {
  IDocumentEvents,
  IDocumentRenderQueue,
  IDocumentRepository,
  IDocumentSettingsStore,
  IDocumentSigners,
  IDocumentSigningLinks,
  IDocumentTemplateRepository,
  ISignerParties,
} from "../../application/ports/IDocumentRecords.js";
import { HandoverDocuments } from "../../application/use-cases/assignments/HandoverDocuments.js";
import {
  PendingDocumentRenders,
  RenderDocument,
  SealDocument,
  SigningMaintenance,
} from "../../application/use-cases/documents/DocumentJobs.js";
import { signingRoutes } from "../../adapters/routes/signingRoutes.js";
import { DocumentPdfComposer } from "../../application/use-cases/documents/DocumentPdfComposer.js";
import { DocumentSettingsService } from "../../application/use-cases/documents/DocumentSettingsService.js";
import { DocumentSigning } from "../../application/use-cases/documents/DocumentSigning.js";
import { SignatureRequests } from "../../application/use-cases/documents/SignatureRequests.js";
import {
  PostgresDocumentSettingsStore,
  PostgresDocumentSigners,
  PostgresDocumentSigningLinks,
  PostgresSignerParties,
} from "../../infrastructure/documents/PostgresSignatures.js";
import { Documents } from "../../application/use-cases/documents/Documents.js";
import { DocumentTemplates } from "../../application/use-cases/documents/DocumentTemplates.js";
import {
  PostgresDocumentEvents,
  PostgresDocumentTemplates,
  PostgresIssuedDocuments,
} from "../../infrastructure/documents/PostgresDocuments.js";
import { QueuedDocumentRendering } from "../../infrastructure/documents/QueuedDocumentRendering.js";
import { driverAppRoutes } from "../../adapters/routes/driverAppRoutes.js";
import type { IDriverAppLinks } from "../../application/ports/IDriverAppLinks.js";
import type { IPdfRenderer } from "../../application/ports/IPdfRenderer.js";
import { BusinessLogo } from "../../application/services/BusinessLogo.js";
import { PrintedDocuments } from "../../application/use-cases/documents/PrintedDocuments.js";
import { DriverApp } from "../../application/use-cases/driverapp/DriverApp.js";
import { DriverAppAccess } from "../../application/use-cases/parties/DriverAppAccess.js";
import { VehicleIssues } from "../../application/use-cases/vehicles/VehicleIssues.js";
import type { IVehicleIssueRepository } from "../../domain/repositories/IVehicleIssueRepository.js";
import { PdfKitRenderer } from "../../infrastructure/documents/PdfKitRenderer.js";
import {
  PostgresDriverAppLinks,
  PostgresVehicleIssues,
} from "../../infrastructure/driverapp/PostgresDriverApp.js";
import { notificationRoutes } from "../../adapters/routes/notificationRoutes.js";
import type {
  INotificationDeliveries,
  INotificationInbox,
  INotificationQueries,
  INotificationSettingsStore,
  IPushDevices,
  IPushSender,
  IRecipientDirectory,
  ISmsGateway,
} from "../../application/ports/INotifications.js";
import { NotificationCenter } from "../../application/use-cases/notifications/NotificationCenter.js";
import {
  RunNotificationRules,
  RunRemittanceCutoff,
  SweepNotifications,
} from "../../application/use-cases/notifications/NotificationJobs.js";
import { NotificationSettingsService } from "../../application/use-cases/notifications/NotificationSettingsService.js";
import { Notifier } from "../../application/use-cases/notifications/Notifier.js";
import { ReminderRules } from "../../application/use-cases/notifications/ReminderRules.js";
import { SendNotifications } from "../../application/use-cases/notifications/SendNotifications.js";
import {
  PostgresNotificationDeliveries,
  PostgresNotificationInbox,
  PostgresNotificationQueries,
  PostgresNotificationSettingsStore,
  PostgresPushDevices,
  PostgresRecipientDirectory,
} from "../../infrastructure/notifications/PostgresNotifications.js";
import {
  FcmPushSender,
  type FcmServiceAccount,
} from "../../infrastructure/notifications/push/FcmPushSender.js";
import { LoggingPushSender } from "../../infrastructure/notifications/push/LoggingPushSender.js";
import {
  ArkeselSmsGateway,
  HubtelSmsGateway,
  MnotifySmsGateway,
} from "../../infrastructure/notifications/sms/SmsGateways.js";
import { dashboardRoutes } from "../../adapters/routes/dashboardRoutes.js";
import type { IDashboardQueries, IVehicleStatsStore } from "../../application/ports/IReporting.js";
import { Dashboards } from "../../application/use-cases/reporting/Dashboards.js";
import { VehicleStatsBuilder } from "../../application/use-cases/reporting/VehicleStatsBuilder.js";
import {
  PostgresDashboardQueries,
  PostgresVehicleStatsStore,
} from "../../infrastructure/reporting/PostgresReporting.js";
import { remittanceRoutes } from "../../adapters/routes/remittanceRoutes.js";
import type {
  IOperationsQueries,
  IRemittanceSettingsStore,
} from "../../application/ports/IRemittanceRecords.js";
import { DriverLedger } from "../../application/use-cases/remittances/DriverLedger.js";
import { OperationsBoard } from "../../application/use-cases/remittances/OperationsBoard.js";
import { RemittancePaymentListener } from "../../application/use-cases/remittances/RemittancePaymentListener.js";
import { RemittancePaymentPurpose } from "../../application/use-cases/remittances/RemittancePaymentPurpose.js";
import { RemittanceScheduler } from "../../application/use-cases/remittances/RemittanceScheduler.js";
import { RemittanceSettingsService } from "../../application/use-cases/remittances/RemittanceSettingsService.js";
import { Remittances } from "../../application/use-cases/remittances/Remittances.js";
import {
  PostgresOperationsQueries,
  PostgresRemittanceSettingsStore,
  PostgresRemittances,
} from "../../infrastructure/remittances/PostgresRemittances.js";
import type { IExpenseRepository } from "../../domain/repositories/IExpenseRepository.js";
import { expenseRoutes } from "../../adapters/routes/expenseRoutes.js";
import type { ITenantDailyTask } from "../../application/jobs/ITenantDailyTask.js";
import type {
  IApprovalRules,
  IBudgets,
  IExpenseSettingsStore,
  IFuelLogs,
  IRecurringExpenses,
} from "../../application/ports/IExpenseRecords.js";
import { ExpenseAdministration } from "../../application/use-cases/expenses/ExpenseAdministration.js";
import { ExpensePaymentListener } from "../../application/use-cases/expenses/ExpensePaymentListener.js";
import { Expenses } from "../../application/use-cases/expenses/Expenses.js";
import { FuelLogs } from "../../application/use-cases/expenses/FuelLogs.js";
import { RecurringExpenses } from "../../application/use-cases/expenses/RecurringExpenses.js";
import {
  PostgresApprovalRules,
  PostgresBudgets,
  PostgresExpenseRepository,
  PostgresExpenseSettingsStore,
  PostgresFuelLogs,
  PostgresRecurringExpenses,
} from "../../infrastructure/expenses/PostgresExpenses.js";
import { financeRoutes } from "../../adapters/routes/financeRoutes.js";
import type {
  IFinanceQueries,
  IFinanceSettingsStore,
  ILedger,
  IPartyDirectory,
} from "../../application/ports/IFinanceRecords.js";
import { TenantCalendar } from "../../application/services/TenantCalendar.js";
import { CashSessions } from "../../application/use-cases/finance/CashSessions.js";
import { FinanceContext } from "../../application/use-cases/finance/FinanceContext.js";
import { FinanceSettingsService } from "../../application/use-cases/finance/FinanceSettingsService.js";
import { Invoicing } from "../../application/use-cases/finance/Invoicing.js";
import { LedgerPosting } from "../../application/use-cases/finance/LedgerPosting.js";
import { LedgerViews } from "../../application/use-cases/finance/LedgerViews.js";
import { PaymentRecording } from "../../application/use-cases/finance/PaymentRecording.js";
import type {
  ICashSessionRepository,
  IInvoiceRepository,
  IPaymentRepository,
} from "../../domain/repositories/IFinanceRepositories.js";
import {
  PostgresCashSessionRepository,
  PostgresFinanceQueries,
  PostgresFinanceSettingsStore,
  PostgresInvoiceRepository,
  PostgresPartyDirectory,
  PostgresPaymentRepository,
} from "../../infrastructure/finance/PostgresFinanceDocuments.js";
import { PostgresCurrencyUsage } from "../../infrastructure/finance/PostgresCurrencyUsage.js";
import { PostgresLedger } from "../../infrastructure/finance/PostgresLedger.js";
import { assignmentRoutes } from "../../adapters/routes/assignmentRoutes.js";
import type { IAssignmentSettingsStore } from "../../application/ports/IAssignmentRecords.js";
import { AssignmentSettingsService } from "../../application/use-cases/assignments/AssignmentSettingsService.js";
import { VehicleAssignments } from "../../application/use-cases/assignments/VehicleAssignments.js";
import {
  PostgresAssignmentRepository,
  PostgresAssignmentSettingsStore,
} from "../../infrastructure/assignments/PostgresAssignmentRepository.js";
import { partyRoutes } from "../../adapters/routes/partyRoutes.js";
import type {
  IDriverGuarantors,
  IDriverSettingsStore,
  IPartyDocuments,
  IPartyStatusHistory,
} from "../../application/ports/IPartyRecords.js";
import { BranchScope } from "../../application/services/BranchScope.js";
import { CustomerAdministration } from "../../application/use-cases/parties/CustomerAdministration.js";
import { DriverAdministration } from "../../application/use-cases/parties/DriverAdministration.js";
import { DriverBranchCheck } from "../../application/use-cases/parties/DriverBranchCheck.js";
import { DriverGuarantors } from "../../application/use-cases/parties/DriverGuarantors.js";
import { DriverSettingsService } from "../../application/use-cases/parties/DriverSettingsService.js";
import { PartyDocuments } from "../../application/use-cases/parties/PartyDocuments.js";
import { SupplierAdministration } from "../../application/use-cases/parties/SupplierAdministration.js";
import { PostgresCustomerRepository } from "../../infrastructure/parties/PostgresCustomerRepository.js";
import { PostgresDriverRepository } from "../../infrastructure/parties/PostgresDriverRepository.js";
import {
  PostgresDriverGuarantors,
  PostgresDriverSettingsStore,
  PostgresPartyDocuments,
  PostgresPartyStatusHistory,
  PostgresSupplierRepository,
} from "../../infrastructure/parties/PostgresPartyRecords.js";
import { vehicleRoutes } from "../../adapters/routes/vehicleRoutes.js";
import type {
  IOdometerReadings,
  IVehicleDocuments,
  IVehicleGroups,
  IVehicleQueries,
  IVehicleSettingsStore,
} from "../../application/ports/IVehicleRecords.js";
import { OdometerLog } from "../../application/use-cases/vehicles/OdometerLog.js";
import { VehicleAccess } from "../../application/use-cases/vehicles/VehicleAccess.js";
import { VehicleBranchCheck } from "../../application/use-cases/vehicles/VehicleBranchCheck.js";
import { VehicleDocuments } from "../../application/use-cases/vehicles/VehicleDocuments.js";
import { VehicleGroupAdministration } from "../../application/use-cases/vehicles/VehicleGroupAdministration.js";
import { VehicleImportExport } from "../../application/use-cases/vehicles/VehicleImportExport.js";
import { VehicleOverview } from "../../application/use-cases/vehicles/VehicleOverview.js";
import { VehiclePhotos } from "../../application/use-cases/vehicles/VehiclePhotos.js";
import { VehicleRegistry } from "../../application/use-cases/vehicles/VehicleRegistry.js";
import { VehicleSettingsService } from "../../application/use-cases/vehicles/VehicleSettingsService.js";
import type { IVehicleRepository } from "../../domain/repositories/IVehicleRepository.js";
import {
  PostgresOdometerReadings,
  PostgresVehicleDocuments,
  PostgresVehicleGroups,
  PostgresVehicleSettingsStore,
} from "../../infrastructure/vehicles/PostgresVehicleRecords.js";
import { PostgresVehicleRepository } from "../../infrastructure/vehicles/PostgresVehicleRepository.js";
import { referenceRoutes } from "../../adapters/routes/referenceRoutes.js";
import type {
  IReferenceData,
  ITenantReferenceData,
} from "../../application/ports/IReferenceData.js";
import type { ICurrencyUsage } from "../../application/ports/ICurrencyUsage.js";
import { CurrencySettingsService } from "../../application/use-cases/reference/CurrencySettingsService.js";
import { DocumentNumbering } from "../../application/use-cases/reference/DocumentNumbering.js";
import { ExpenseCategoryAdministration } from "../../application/use-cases/reference/ExpenseCategoryAdministration.js";
import { FxRateBook } from "../../application/use-cases/reference/FxRateBook.js";
import { TaxAdministration } from "../../application/use-cases/reference/TaxAdministration.js";
import { VehicleCatalogue } from "../../application/use-cases/reference/VehicleCatalogue.js";
import { PostgresReferenceData } from "../../infrastructure/reference/PostgresReferenceData.js";
import { PostgresTenantReferenceData } from "../../infrastructure/reference/PostgresTenantReferenceData.js";
import { billingRoutes } from "../../adapters/routes/billingRoutes.js";
import { billingAutomationRoutes } from "../../adapters/routes/billingAutomationRoutes.js";
import { BranchReconciliation } from "../../application/use-cases/billing/BranchReconciliation.js";
import { OpenItemsBranchCheck } from "../../application/use-cases/tenants/OpenItemsBranchCheck.js";
import type { IBranchContents } from "../../application/ports/IBranchContents.js";
import type { IBranchReconciliationRepository } from "../../domain/repositories/IBranchReconciliationRepository.js";
import { PostgresBranchReconciliationRepository } from "../../infrastructure/billing/PostgresBranchReconciliationRepository.js";
import { PostgresBranchContents } from "../../infrastructure/tenants/PostgresBranchContents.js";
import { legalOperationsRoutes } from "../../adapters/routes/legalOperationsRoutes.js";
import type { ITenantDataArchiver } from "../../application/ports/ITenantDataArchiver.js";
import {
  ComplianceDaily,
  DataProtectionRequests,
  RestoreDrills,
  StatusPage,
} from "../../application/use-cases/console/ComplianceOperations.js";
import { LaunchReadiness } from "../../application/use-cases/console/LaunchReadiness.js";
import { LegalDocuments } from "../../application/use-cases/console/LegalDocuments.js";
import { TenantDataExports } from "../../application/use-cases/console/TenantDataExports.js";
import type {
  IDataProtectionRequestRepository,
  IIncidentRepository,
  IRestoreDrillRepository,
} from "../../domain/repositories/IComplianceRepositories.js";
import type { ILegalRepository } from "../../domain/repositories/ILegalRepository.js";
import type { ITenantDataExportRepository } from "../../domain/repositories/ITenantDataExportRepository.js";
import { PostgresTenantDataArchiver } from "../../infrastructure/exports/PostgresTenantDataArchiver.js";
import { PostgresTenantDataExportRepository } from "../../infrastructure/exports/PostgresTenantDataExportRepository.js";
import {
  PostgresDataProtectionRequestRepository,
  PostgresIncidentRepository,
  PostgresRestoreDrillRepository,
} from "../../infrastructure/legal/PostgresComplianceRepositories.js";
import { PostgresLegalRepository } from "../../infrastructure/legal/PostgresLegalRepository.js";
import { consoleOperationsRoutes } from "../../adapters/routes/consoleOperationsRoutes.js";
import type { IOnCallWebhook } from "../../application/ports/IOnCallWebhook.js";
import type { ITenantUsageCollector } from "../../application/ports/ITenantUsageCollector.js";
import {
  AnnouncementMailer,
  Communications,
  MaintenanceState,
} from "../../application/use-cases/console/Communications.js";
import { FeatureFlags } from "../../application/use-cases/console/FeatureFlags.js";
import {
  AlertNotifier,
  PlatformAlerts,
  type IAlerts,
} from "../../application/use-cases/console/PlatformAlerts.js";
import { SupportAccess } from "../../application/use-cases/console/SupportAccess.js";
import {
  TenantUsageHistory,
  UsageMeter,
} from "../../application/use-cases/console/TenantUsageHistory.js";
import { TenantUserSupport } from "../../application/use-cases/console/TenantUserSupport.js";
import type { ICommunicationsRepository } from "../../domain/repositories/ICommunicationsRepository.js";
import type { IFeatureFlagRepository } from "../../domain/repositories/IFeatureFlagRepository.js";
import type { IPlatformAlertRepository } from "../../domain/repositories/IPlatformAlertRepository.js";
import type { ISupportSessionRepository } from "../../domain/repositories/ISupportSessionRepository.js";
import type { IUsageRepository } from "../../domain/repositories/IUsageRepository.js";
import { HttpOnCallWebhook } from "../../infrastructure/console/HttpOnCallWebhook.js";
import { PostgresCommunicationsRepository } from "../../infrastructure/console/PostgresCommunicationsRepository.js";
import { PostgresFeatureFlagRepository } from "../../infrastructure/console/PostgresFeatureFlagRepository.js";
import { PostgresPlatformAlertRepository } from "../../infrastructure/console/PostgresPlatformAlertRepository.js";
import { PostgresSupportSessionRepository } from "../../infrastructure/console/PostgresSupportSessionRepository.js";
import { PostgresTenantUsageCollector } from "../../infrastructure/console/PostgresTenantUsageCollector.js";
import { PostgresUsageRepository } from "../../infrastructure/console/PostgresUsageRepository.js";
import { partnerCommissionRoutes } from "../../adapters/routes/partnerCommissionRoutes.js";
import type { ICommissionHooks } from "../../application/ports/ICommissionHooks.js";
import { CommissionEngine } from "../../application/use-cases/partners/CommissionEngine.js";
import { PartnerCommissions } from "../../application/use-cases/partners/PartnerCommissions.js";
import { PartnerNotifier } from "../../application/use-cases/partners/PartnerNotifier.js";
import type { IPartnerCommissionRepository } from "../../domain/repositories/IPartnerCommissionRepository.js";
import { PostgresPartnerCommissionRepository } from "../../infrastructure/partners/PostgresPartnerCommissionRepository.js";
import { enterpriseQuoteRoutes } from "../../adapters/routes/enterpriseQuoteRoutes.js";
import { EnterpriseQuotes } from "../../application/use-cases/billing/EnterpriseQuotes.js";
import type { IEnterpriseQuoteRepository } from "../../domain/repositories/IEnterpriseQuoteRepository.js";
import { PostgresEnterpriseQuoteRepository } from "../../infrastructure/billing/PostgresEnterpriseQuoteRepository.js";
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
          maxTotalConnections: db.tenantPools.maxTotalConnections,
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
      (tx: PostgresTransactionContext, requestContext: IRequestContext) =>
        new PostgresAuditTrail(tx, requestContext),
      [TYPES.PostgresTransactionContext, TYPES.RequestContext],
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

  container.bind<IJobHandler[]>(TYPES.JobHandlers).toResolvedValue(
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
      tasks: ITenantDailyTask[],
      notificationHandlers: IJobHandler[],
      documentHandlers: IJobHandler[],
      reconciliation: GatewayReconciliation,
      automation: BillingAutomation,
      branchReconciliation: BranchReconciliation,
      alertNotifier: AlertNotifier,
      announcementMailer: AnnouncementMailer,
      usageHistory: TenantUsageHistory,
      dataExports: TenantDataExports,
      complianceDaily: ComplianceDaily,
    ): IJobHandler[] => [
      new DrainOutbox({ unitOfWork, outbox, handlers, queue, clock }),
      new SweepOutboxes({ roster, queue }),
      new DeliverEvent({ unitOfWork, processed, handlers, logger }),
      new RunTenantSchedules({ roster, ledger, clock, logger }),
      new RunDailyMaintenance({
        unitOfWork,
        retention,
        clock,
        logger,
        files: tenantFiles,
        tasks,
      }),
      new SendQueuedEmail({ deliveries, sender, clock, logger }),
      new SweepAbandonedFiles({ files: platformFiles, logger }),
      ...provisioningHandlers,
      ...notificationHandlers,
      ...documentHandlers,
      reconciliation,
      automation,
      branchReconciliation,
      alertNotifier,
      announcementMailer,
      usageHistory,
      dataExports,
      complianceDaily,
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
      TYPES.TenantDailyTasks,
      TYPES.NotificationJobHandlers,
      TYPES.DocumentJobHandlers,
      TYPES.GatewayReconciliation,
      TYPES.BillingAutomation,
      TYPES.BranchReconciliation,
      TYPES.AlertNotifier,
      TYPES.AnnouncementMailer,
      TYPES.TenantUsageHistory,
      TYPES.TenantDataExports,
      TYPES.ComplianceDaily,
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
      tenants: ITenantDirectory,
      permissions: IPermissionResolver,
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
        billingOnly: { tenants, permissions },
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
      TYPES.TenantDirectory,
      TYPES.PermissionResolver,
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

  container.bind<AuthenticateTenantRequest>(TYPES.AuthenticateTenantRequest).toResolvedValue(
    (
      accessTokens: IAccessTokenService,
      tenants: ITenantDirectory,
      permissions: IPermissionResolver,
    ) =>
      new AuthenticateTenantRequest({
        accessTokens,
        tenants,
        permissions,
        // Resolved late: support access depends on much of the container.
        support: {
          live: (sessionId, tenantId) =>
            container.get<SupportAccess>(TYPES.SupportAccess).live(sessionId, tenantId),
          record: (sessionId, request) =>
            container.get<SupportAccess>(TYPES.SupportAccess).record(sessionId, request),
        },
      }),
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
        // Resolved late: the legal documents come later in the container.
        legal: {
          recordSignup: (applicationId, context) =>
            container
              .get<LegalDocuments>(TYPES.LegalDocuments)
              .recordSignup(applicationId, context),
        },
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
      commissions: IPartnerCommissionRepository,
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
        commissionTerms: (partnerId) => commissions.latestTerms(partnerId),
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
      TYPES.PartnerCommissionRepository,
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
  tenantRepository<IBranchContents>(TYPES.BranchContents, (tx) => new PostgresBranchContents(tx));
  tenantRepository<IOrganisationReader>(
    TYPES.OrganisationReader,
    (tx) => new PostgresOrganisationReader(tx),
  );
  // Modules register their branch-deactivation checks here (open rentals, cash sessions, …).
  container
    .bind<IBranchDeactivationCheck[]>(TYPES.BranchDeactivationChecks)
    .toResolvedValue(
      (vehicles: IVehicleQueries, drivers: PostgresDriverRepository, contents: IBranchContents) => [
        new VehicleBranchCheck(vehicles),
        new DriverBranchCheck(drivers),
        new OpenItemsBranchCheck(contents),
      ],
      [TYPES.VehicleQueries, TYPES.DriverRepository, TYPES.BranchContents],
    );

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
      contents: IBranchContents,
    ) =>
      new BranchLifecycle({
        unitOfWork,
        branches,
        contents,
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
      TYPES.BranchContents,
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
    ) =>
      new OrganisationAdministration({
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
    ],
  );

  // --- Billing (subscriptions, entitlements, manual invoices and payments) ---
  platformRepository<IBillingRepository>(
    TYPES.BillingRepository,
    (p) => new PostgresBillingRepository(p),
  );
  platformRepository<IEnterpriseQuoteRepository>(
    TYPES.EnterpriseQuoteRepository,
    (p) => new PostgresEnterpriseQuoteRepository(p),
  );
  container.bind<SubscriptionAdministration>(TYPES.SubscriptionAdministration).toResolvedValue(
    (
      billing: IBillingRepository,
      quotes: IEnterpriseQuoteRepository,
      unitOfWork: IPlatformUnitOfWork,
      audit: IPlatformAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new SubscriptionAdministration({
        billing,
        quotes,
        unitOfWork,
        audit,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.BillingRepository,
      TYPES.EnterpriseQuoteRepository,
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
      renderer: IPdfRenderer,
      directory: ITenantDirectory,
      extensions: IBillingAutomationRepository,
      quotes: IEnterpriseQuoteRepository,
      commissions: ICommissionHooks,
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
        documents: new BillingDocuments({ renderer, clock }),
        directory,
        extensions,
        quotes,
        commissions,
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
      TYPES.PdfRenderer,
      TYPES.TenantDirectory,
      TYPES.BillingAutomationRepository,
      TYPES.EnterpriseQuoteRepository,
      TYPES.CommissionEngine,
    ],
  );
  container
    .bind<BranchEntitlements>(TYPES.BranchEntitlements)
    .toResolvedValue(
      (
        billing: IBillingRepository,
        subscriptions: SubscriptionAdministration,
        unitOfWork: IPlatformUnitOfWork,
        ids: IIdGenerator,
        clock: IClock,
        reconciliations: IBranchReconciliationRepository,
      ) =>
        new BranchEntitlements({ billing, subscriptions, reconciliations, unitOfWork, ids, clock }),
      [
        TYPES.BillingRepository,
        TYPES.SubscriptionAdministration,
        TYPES.PlatformUnitOfWork,
        TYPES.IdGenerator,
        TYPES.Clock,
        TYPES.BranchReconciliationRepository,
      ],
    );
  container.bind<TenantBilling>(TYPES.TenantBilling).toResolvedValue(
    (
      subscriptions: SubscriptionAdministration,
      billing: ManualBilling,
      records: IBillingRepository,
      unitOfWork: IPlatformUnitOfWork,
      tenantContext: ITenantContext,
      ids: IIdGenerator,
      clock: IClock,
      renderer: IPdfRenderer,
    ) =>
      new TenantBilling({
        subscriptions,
        billing,
        records,
        documents: new BillingDocuments({ renderer, clock }),
        unitOfWork,
        tenantContext,
        ids,
        clock,
      }),
    [
      TYPES.SubscriptionAdministration,
      TYPES.ManualBilling,
      TYPES.BillingRepository,
      TYPES.PlatformUnitOfWork,
      TYPES.TenantContext,
      TYPES.IdGenerator,
      TYPES.Clock,
      TYPES.PdfRenderer,
    ],
  );

  // --- Payment gateway (P4-2) ---
  container.bind<IPaymentGateway>(TYPES.PaymentGateway).toResolvedValue(() =>
    config.billing.gateway === "paystack"
      ? new PaystackGateway({
          secretKey: config.billing.paystackSecretKey!,
          baseUrl: config.billing.paystackBaseUrl,
        })
      : new FakePaymentGateway({
          webhookSecret: config.billing.fakeWebhookSecret,
          checkoutBaseUrl: config.billing.returnUrl,
        }),
  );
  platformRepository<IGatewayRepository>(
    TYPES.GatewayRepository,
    (p) => new PostgresGatewayRepository(p),
  );
  container.bind<GatewayBilling>(TYPES.GatewayBilling).toResolvedValue(
    (
      provider: IPaymentGateway,
      gateway: IGatewayRepository,
      records: IBillingRepository,
      billing: ManualBilling,
      lifecycle: TenantLifecycleService,
      secrets: ISecretBox,
      unitOfWork: IPlatformUnitOfWork,
      tenantContext: ITenantContext,
      audit: IPlatformAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
      logger: ILogger,
      commissions: ICommissionHooks,
      approvals: ApprovalWorkflow,
    ) => {
      const gatewayBilling = new GatewayBilling({
        provider,
        gateway,
        records,
        billing,
        lifecycle,
        secrets,
        unitOfWork,
        tenantContext,
        audit,
        requestContext,
        ids,
        clock,
        logger,
        returnUrl: config.billing.returnUrl,
        commissions,
        refundApproval: {
          approvals,
          thresholdMinor: config.operations.refundApprovalThresholdMinor,
        },
      });
      approvals.register(gatewayBilling.refundExecutor());
      return gatewayBilling;
    },
    [
      TYPES.PaymentGateway,
      TYPES.GatewayRepository,
      TYPES.BillingRepository,
      TYPES.ManualBilling,
      TYPES.TenantLifecycleService,
      TYPES.SecretBox,
      TYPES.PlatformUnitOfWork,
      TYPES.TenantContext,
      TYPES.PlatformAuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
      TYPES.Logger,
      TYPES.CommissionEngine,
      TYPES.ApprovalWorkflow,
    ],
  );
  container.bind<GatewayReconciliation>(TYPES.GatewayReconciliation).toResolvedValue(
    (
      provider: IPaymentGateway,
      gateway: IGatewayRepository,
      payments: GatewayBilling,
      unitOfWork: IPlatformUnitOfWork,
      audit: IPlatformAuditTrail,
      requestContext: IRequestContext,
      clock: IClock,
      logger: ILogger,
    ) =>
      new GatewayReconciliation({
        provider,
        gateway,
        payments,
        unitOfWork,
        audit,
        requestContext,
        clock,
        logger,
        alerts: lazyAlerts,
      }),
    [
      TYPES.PaymentGateway,
      TYPES.GatewayRepository,
      TYPES.GatewayBilling,
      TYPES.PlatformUnitOfWork,
      TYPES.PlatformAuditTrail,
      TYPES.RequestContext,
      TYPES.Clock,
      TYPES.Logger,
    ],
  );

  // --- Billing automation (P4-3) ---
  platformRepository<IBillingAutomationRepository>(
    TYPES.BillingAutomationRepository,
    (p) => new PostgresBillingAutomationRepository(p),
  );
  container.bind<BillingNotices>(TYPES.BillingNotices).toResolvedValue(
    (
      automation: IBillingAutomationRepository,
      email: NotificationService,
      sms: ISmsSender,
      tenantContext: ITenantContext,
      tenantUnitOfWork: IUnitOfWork,
      notifier: Notifier,
      settings: INotificationSettingsStore,
      seeder: ITenantSeeder,
      logger: ILogger,
    ) =>
      new BillingNotices({
        automation,
        email,
        sms,
        tenantContext,
        tenantUnitOfWork,
        notifier,
        settings,
        seeder,
        logger,
        billingUrl: `${config.public.webAppUrl}/billing`,
      }),
    [
      TYPES.BillingAutomationRepository,
      TYPES.NotificationService,
      TYPES.SmsSender,
      TYPES.TenantContext,
      TYPES.UnitOfWork,
      TYPES.Notifier,
      TYPES.NotificationSettingsStore,
      TYPES.TenantSeeder,
      TYPES.Logger,
    ],
  );
  container.bind<BillingAutomation>(TYPES.BillingAutomation).toResolvedValue(
    (
      automation: IBillingAutomationRepository,
      billing: IBillingRepository,
      invoices: ManualBilling,
      gateway: GatewayBilling,
      lifecycle: TenantLifecycleService,
      notices: BillingNotices,
      unitOfWork: IPlatformUnitOfWork,
      audit: IPlatformAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
      logger: ILogger,
      partnerNotifier: PartnerNotifier,
    ) =>
      new BillingAutomation({
        resellers: {
          tell: (tenantId, message) => partnerNotifier.tellTenantReseller(tenantId, message),
        },
        alerts: lazyAlerts,
        automation,
        billing,
        invoices,
        gateway,
        lifecycle,
        notices,
        unitOfWork,
        audit,
        requestContext,
        ids,
        clock,
        logger,
      }),
    [
      TYPES.BillingAutomationRepository,
      TYPES.BillingRepository,
      TYPES.ManualBilling,
      TYPES.GatewayBilling,
      TYPES.TenantLifecycleService,
      TYPES.BillingNotices,
      TYPES.PlatformUnitOfWork,
      TYPES.PlatformAuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
      TYPES.Logger,
      TYPES.PartnerNotifier,
    ],
  );
  container.bind<BillingExtensions>(TYPES.BillingExtensions).toResolvedValue(
    (
      automation: IBillingAutomationRepository,
      billing: IBillingRepository,
      lifecycle: TenantLifecycleService,
      notices: BillingNotices,
      unitOfWork: IPlatformUnitOfWork,
      audit: IPlatformAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
      logger: ILogger,
    ) =>
      new BillingExtensions({
        automation,
        billing,
        lifecycle,
        notices,
        unitOfWork,
        audit,
        requestContext,
        ids,
        clock,
        logger,
      }),
    [
      TYPES.BillingAutomationRepository,
      TYPES.BillingRepository,
      TYPES.TenantLifecycleService,
      TYPES.BillingNotices,
      TYPES.PlatformUnitOfWork,
      TYPES.PlatformAuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
      TYPES.Logger,
    ],
  );

  // --- Branch entitlements (P4-5) ---
  platformRepository<IBranchReconciliationRepository>(
    TYPES.BranchReconciliationRepository,
    (p) => new PostgresBranchReconciliationRepository(p),
  );
  container.bind<BranchReconciliation>(TYPES.BranchReconciliation).toResolvedValue(
    (
      roster: ITenantRoster,
      tenantContext: ITenantContext,
      tenantUnitOfWork: IUnitOfWork,
      branches: IBranches,
      entitlements: BranchEntitlements,
      reconciliations: IBranchReconciliationRepository,
      unitOfWork: IPlatformUnitOfWork,
      audit: IPlatformAuditTrail,
      requestContext: IRequestContext,
      logger: ILogger,
    ) =>
      new BranchReconciliation({
        alerts: lazyAlerts,
        roster,
        tenantContext,
        tenantUnitOfWork,
        branches,
        entitlements,
        reconciliations,
        unitOfWork,
        audit,
        requestContext,
        logger,
      }),
    [
      TYPES.TenantRoster,
      TYPES.TenantContext,
      TYPES.UnitOfWork,
      TYPES.Branches,
      TYPES.BranchEntitlements,
      TYPES.BranchReconciliationRepository,
      TYPES.PlatformUnitOfWork,
      TYPES.PlatformAuditTrail,
      TYPES.RequestContext,
      TYPES.Logger,
    ],
  );

  // --- Console operations (P4-7) ---
  const operations = config.operations;
  const onCall = {
    emails: operations.onCallEmails,
    minSeverity: operations.onCallMinSeverity,
    consoleUrl: auth.platform.consoleUrl,
  };
  platformRepository<IPlatformAlertRepository>(
    TYPES.PlatformAlertRepository,
    (p) => new PostgresPlatformAlertRepository(p),
  );
  container
    .bind<IOnCallWebhook>(TYPES.OnCallWebhook)
    .toResolvedValue(() => new HttpOnCallWebhook(operations.onCallWebhookUrl));
  container.bind<PlatformAlerts>(TYPES.PlatformAlerts).toResolvedValue(
    (
      alerts: IPlatformAlertRepository,
      queue: IJobQueue,
      unitOfWork: IPlatformUnitOfWork,
      audit: IPlatformAuditTrail,
      requestContext: IRequestContext,
      clock: IClock,
      logger: ILogger,
    ) =>
      new PlatformAlerts({
        alerts,
        queue,
        unitOfWork,
        audit,
        requestContext,
        clock,
        logger,
        onCall,
      }),
    [
      TYPES.PlatformAlertRepository,
      TYPES.JobQueue,
      TYPES.PlatformUnitOfWork,
      TYPES.PlatformAuditTrail,
      TYPES.RequestContext,
      TYPES.Clock,
      TYPES.Logger,
    ],
  );
  /** Alerts raised anywhere, resolved late: they never form a dependency cycle. */
  const lazyAlerts: IAlerts = {
    raise: (input) => container.get<PlatformAlerts>(TYPES.PlatformAlerts).raise(input),
  };
  container
    .bind<AlertNotifier>(TYPES.AlertNotifier)
    .toResolvedValue(
      (
        alerts: IPlatformAlertRepository,
        webhook: IOnCallWebhook,
        email: NotificationService,
        clock: IClock,
      ) => new AlertNotifier({ alerts, webhook, email, clock, onCall }),
      [TYPES.PlatformAlertRepository, TYPES.OnCallWebhook, TYPES.NotificationService, TYPES.Clock],
    );

  platformRepository<ISupportSessionRepository>(
    TYPES.SupportSessionRepository,
    (p) => new PostgresSupportSessionRepository(p),
  );
  container.bind<SupportAccess>(TYPES.SupportAccess).toResolvedValue(
    (
      sessions: ISupportSessionRepository,
      approvals: ApprovalWorkflow,
      directory: ITenantDirectory,
      tenantContext: ITenantContext,
      tenantUnitOfWork: IUnitOfWork,
      seeder: ITenantSeeder,
      permissions: IPermissionResolver,
      accessTokens: IAccessTokenService,
      unitOfWork: IPlatformUnitOfWork,
      audit: IPlatformAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
      logger: ILogger,
      staffSessions: StaffSessions,
    ) => {
      const support = new SupportAccess({
        sessions,
        approvals,
        directory,
        tenantContext,
        tenantUnitOfWork,
        seeder,
        permissions,
        accessTokens,
        alerts: lazyAlerts,
        unitOfWork,
        audit,
        requestContext,
        ids,
        clock,
        logger,
        stepUpMs: staffSessions.settings.stepUpMs,
      });
      approvals.register(support.executor());
      return support;
    },
    [
      TYPES.SupportSessionRepository,
      TYPES.ApprovalWorkflow,
      TYPES.TenantDirectory,
      TYPES.TenantContext,
      TYPES.UnitOfWork,
      TYPES.TenantSeeder,
      TYPES.PermissionResolver,
      TYPES.AccessTokenService,
      TYPES.PlatformUnitOfWork,
      TYPES.PlatformAuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
      TYPES.Logger,
      TYPES.StaffSessions,
    ],
  );
  container.bind<TenantUserSupport>(TYPES.TenantUserSupport).toResolvedValue(
    (
      directory: ITenantDirectory,
      userDirectory: IUserDirectory,
      tenantContext: ITenantContext,
      tenantUnitOfWork: IUnitOfWork,
      users: ITenantUserRepository,
      sessions: ITenantSessions,
      tenantAudit: IAuditTrail,
      permissionCache: IPermissionCache,
      signIn: TenantSignIn,
      approvals: ApprovalWorkflow,
      unitOfWork: IPlatformUnitOfWork,
      audit: IPlatformAuditTrail,
      requestContext: IRequestContext,
      clock: IClock,
    ) => {
      const support = new TenantUserSupport({
        directory,
        userDirectory,
        tenantContext,
        tenantUnitOfWork,
        users,
        sessions,
        tenantAudit,
        permissionCache,
        signIn,
        approvals,
        unitOfWork,
        audit,
        requestContext,
        clock,
      });
      approvals.register(support.executor());
      return support;
    },
    [
      TYPES.TenantDirectory,
      TYPES.UserDirectory,
      TYPES.TenantContext,
      TYPES.UnitOfWork,
      TYPES.TenantUserRepository,
      TYPES.TenantSessions,
      TYPES.AuditTrail,
      TYPES.PermissionCache,
      TYPES.TenantSignIn,
      TYPES.ApprovalWorkflow,
      TYPES.PlatformUnitOfWork,
      TYPES.PlatformAuditTrail,
      TYPES.RequestContext,
      TYPES.Clock,
    ],
  );

  platformRepository<ICommunicationsRepository>(
    TYPES.CommunicationsRepository,
    (p) => new PostgresCommunicationsRepository(p),
  );
  container
    .bind<MaintenanceState>(TYPES.MaintenanceState)
    .toResolvedValue(
      (store: ICommunicationsRepository, clock: IClock) => new MaintenanceState({ store, clock }),
      [TYPES.CommunicationsRepository, TYPES.Clock],
    );
  container.bind<Communications>(TYPES.Communications).toResolvedValue(
    (
      store: ICommunicationsRepository,
      approvals: ApprovalWorkflow,
      queue: IJobQueue,
      unitOfWork: IPlatformUnitOfWork,
      audit: IPlatformAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
      maintenance: MaintenanceState,
    ) => {
      const communications = new Communications({
        store,
        approvals,
        queue,
        unitOfWork,
        audit,
        requestContext,
        ids,
        clock,
        bulkApprovalTenants: operations.bulkMessageApprovalTenants,
        maintenance,
      });
      approvals.register(communications.executor());
      return communications;
    },
    [
      TYPES.CommunicationsRepository,
      TYPES.ApprovalWorkflow,
      TYPES.JobQueue,
      TYPES.PlatformUnitOfWork,
      TYPES.PlatformAuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
      TYPES.MaintenanceState,
    ],
  );
  container.bind<AnnouncementMailer>(TYPES.AnnouncementMailer).toResolvedValue(
    (
      store: ICommunicationsRepository,
      tenantContext: ITenantContext,
      tenantUnitOfWork: IUnitOfWork,
      seeder: ITenantSeeder,
      email: NotificationService,
      clock: IClock,
      logger: ILogger,
    ) =>
      new AnnouncementMailer({
        store,
        tenantContext,
        tenantUnitOfWork,
        seeder,
        email,
        clock,
        logger,
      }),
    [
      TYPES.CommunicationsRepository,
      TYPES.TenantContext,
      TYPES.UnitOfWork,
      TYPES.TenantSeeder,
      TYPES.NotificationService,
      TYPES.Clock,
      TYPES.Logger,
    ],
  );

  platformRepository<IFeatureFlagRepository>(
    TYPES.FeatureFlagRepository,
    (p) => new PostgresFeatureFlagRepository(p),
  );
  container
    .bind<FeatureFlags>(TYPES.FeatureFlags)
    .toResolvedValue(
      (
        flags: IFeatureFlagRepository,
        directory: ITenantDirectory,
        unitOfWork: IPlatformUnitOfWork,
        audit: IPlatformAuditTrail,
        requestContext: IRequestContext,
        clock: IClock,
        logger: ILogger,
      ) => new FeatureFlags({ flags, directory, unitOfWork, audit, requestContext, clock, logger }),
      [
        TYPES.FeatureFlagRepository,
        TYPES.TenantDirectory,
        TYPES.PlatformUnitOfWork,
        TYPES.PlatformAuditTrail,
        TYPES.RequestContext,
        TYPES.Clock,
        TYPES.Logger,
      ],
    );

  platformRepository<IUsageRepository>(
    TYPES.UsageRepository,
    (p) => new PostgresUsageRepository(p),
  );
  container
    .bind<ITenantUsageCollector>(TYPES.TenantUsageCollector)
    .toResolvedValue(
      (pools: TenantConnectionPools) => new PostgresTenantUsageCollector(pools),
      [TYPES.TenantConnectionPools],
    );
  container
    .bind<UsageMeter>(TYPES.UsageMeter)
    .toResolvedValue(
      (usage: IUsageRepository, clock: IClock, logger: ILogger) =>
        new UsageMeter({ usage, clock, logger }),
      [TYPES.UsageRepository, TYPES.Clock, TYPES.Logger],
    )
    .onDeactivation((meter) => meter.stop());
  container
    .bind<TenantUsageHistory>(TYPES.TenantUsageHistory)
    .toResolvedValue(
      (
        usage: IUsageRepository,
        collector: ITenantUsageCollector,
        roster: ITenantRoster,
        clock: IClock,
        logger: ILogger,
      ) => new TenantUsageHistory({ usage, collector, roster, clock, logger }),
      [
        TYPES.UsageRepository,
        TYPES.TenantUsageCollector,
        TYPES.TenantRoster,
        TYPES.Clock,
        TYPES.Logger,
      ],
    );

  // --- Legal and operations (P4-8) ---
  const platformDeps = [
    TYPES.PlatformUnitOfWork,
    TYPES.PlatformAuditTrail,
    TYPES.RequestContext,
    TYPES.IdGenerator,
    TYPES.Clock,
  ] as const;
  platformRepository<ILegalRepository>(
    TYPES.LegalRepository,
    (p) => new PostgresLegalRepository(p),
  );
  container
    .bind<LegalDocuments>(TYPES.LegalDocuments)
    .toResolvedValue(
      (
        legal: ILegalRepository,
        unitOfWork: IPlatformUnitOfWork,
        audit: IPlatformAuditTrail,
        requestContext: IRequestContext,
        ids: IIdGenerator,
        clock: IClock,
      ) => new LegalDocuments({ legal, unitOfWork, audit, requestContext, ids, clock }),
      [TYPES.LegalRepository, ...platformDeps],
    );
  platformRepository<ITenantDataExportRepository>(
    TYPES.TenantDataExportRepository,
    (p) => new PostgresTenantDataExportRepository(p),
  );
  container
    .bind<ITenantDataArchiver>(TYPES.TenantDataArchiver)
    .toResolvedValue(
      (pools: TenantConnectionPools, storage: IObjectStorage) =>
        new PostgresTenantDataArchiver(pools, storage),
      [TYPES.TenantConnectionPools, TYPES.ObjectStorage],
    );
  container.bind<TenantDataExports>(TYPES.TenantDataExports).toResolvedValue(
    (
      exports: ITenantDataExportRepository,
      archiver: ITenantDataArchiver,
      storage: IObjectStorage,
      queue: IJobQueue,
      directory: ITenantDirectory,
      tenantContext: ITenantContext,
      tenantUnitOfWork: IUnitOfWork,
      seeder: ITenantSeeder,
      tenantAudit: IAuditTrail,
      email: NotificationService,
      unitOfWork: IPlatformUnitOfWork,
      audit: IPlatformAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
      logger: ILogger,
    ) =>
      new TenantDataExports({
        exports,
        archiver,
        storage,
        queue,
        directory,
        tenantContext,
        tenantUnitOfWork,
        seeder,
        tenantAudit,
        email,
        unitOfWork,
        audit,
        requestContext,
        ids,
        clock,
        logger,
        exportsUrl: `${config.public.webAppUrl}/settings/data-export`,
      }),
    [
      TYPES.TenantDataExportRepository,
      TYPES.TenantDataArchiver,
      TYPES.ObjectStorage,
      TYPES.JobQueue,
      TYPES.TenantDirectory,
      TYPES.TenantContext,
      TYPES.UnitOfWork,
      TYPES.TenantSeeder,
      TYPES.AuditTrail,
      TYPES.NotificationService,
      TYPES.PlatformUnitOfWork,
      TYPES.PlatformAuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
      TYPES.Logger,
    ],
  );
  platformRepository<IDataProtectionRequestRepository>(
    TYPES.DataProtectionRequestRepository,
    (p) => new PostgresDataProtectionRequestRepository(p),
  );
  platformRepository<IIncidentRepository>(
    TYPES.IncidentRepository,
    (p) => new PostgresIncidentRepository(p),
  );
  platformRepository<IRestoreDrillRepository>(
    TYPES.RestoreDrillRepository,
    (p) => new PostgresRestoreDrillRepository(p),
  );
  container
    .bind<DataProtectionRequests>(TYPES.DataProtectionRequests)
    .toResolvedValue(
      (
        requests: IDataProtectionRequestRepository,
        unitOfWork: IPlatformUnitOfWork,
        audit: IPlatformAuditTrail,
        requestContext: IRequestContext,
        ids: IIdGenerator,
        clock: IClock,
      ) => new DataProtectionRequests({ requests, unitOfWork, audit, requestContext, ids, clock }),
      [TYPES.DataProtectionRequestRepository, ...platformDeps],
    );
  container.bind<StatusPage>(TYPES.StatusPage).toResolvedValue(
    (
      incidents: IIncidentRepository,
      communications: ICommunicationsRepository,
      unitOfWork: IPlatformUnitOfWork,
      audit: IPlatformAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new StatusPage({
        incidents,
        communications,
        unitOfWork,
        audit,
        requestContext,
        ids,
        clock,
      }),
    [TYPES.IncidentRepository, TYPES.CommunicationsRepository, ...platformDeps],
  );
  container
    .bind<RestoreDrills>(TYPES.RestoreDrills)
    .toResolvedValue(
      (
        drills: IRestoreDrillRepository,
        unitOfWork: IPlatformUnitOfWork,
        audit: IPlatformAuditTrail,
        requestContext: IRequestContext,
        ids: IIdGenerator,
        clock: IClock,
      ) => new RestoreDrills({ drills, unitOfWork, audit, requestContext, ids, clock }),
      [TYPES.RestoreDrillRepository, ...platformDeps],
    );
  container
    .bind<ComplianceDaily>(TYPES.ComplianceDaily)
    .toResolvedValue(
      (
        drills: RestoreDrills,
        requests: DataProtectionRequests,
        exports: TenantDataExports,
        clock: IClock,
        logger: ILogger,
      ) => new ComplianceDaily({ drills, requests, exports, alerts: lazyAlerts, clock, logger }),
      [
        TYPES.RestoreDrills,
        TYPES.DataProtectionRequests,
        TYPES.TenantDataExports,
        TYPES.Clock,
        TYPES.Logger,
      ],
    );

  // --- Launch readiness (P4-9) ---
  container.bind<LaunchReadiness>(TYPES.LaunchReadiness).toResolvedValue(
    (
      subscriptions: SubscriptionAdministration,
      automation: BillingAutomation,
      legal: LegalDocuments,
      alerts: PlatformAlerts,
      drills: RestoreDrills,
      dataOperations: DataOperationsConsole,
      roles: IPlatformRoles,
      clock: IClock,
    ) =>
      new LaunchReadiness({
        subscriptions,
        automation,
        legal,
        alerts,
        drills,
        dataOperations,
        roles,
        clock,
        settings: {
          production: config.isProduction,
          gateway: config.billing.gateway,
          onCallEmails: config.operations.onCallEmails.length,
          onCallWebhook: config.operations.onCallWebhookUrl !== null,
        },
      }),
    [
      TYPES.SubscriptionAdministration,
      TYPES.BillingAutomation,
      TYPES.LegalDocuments,
      TYPES.PlatformAlerts,
      TYPES.RestoreDrills,
      TYPES.DataOperationsConsole,
      TYPES.PlatformRoles,
      TYPES.Clock,
    ],
  );

  // --- Reseller commissions (P4-6) ---
  platformRepository<IPartnerCommissionRepository>(
    TYPES.PartnerCommissionRepository,
    (p) => new PostgresPartnerCommissionRepository(p),
  );
  container.bind<PartnerNotifier>(TYPES.PartnerNotifier).toResolvedValue(
    (
      partners: IPartnerRepository,
      email: NotificationService,
      commissions: IPartnerCommissionRepository,
    ) =>
      new PartnerNotifier({
        partners,
        email,
        consoleUrl: auth.platform.consoleUrl,
        attributions: (tenantId) => commissions.attribution(tenantId),
      }),
    [TYPES.PartnerRepository, TYPES.NotificationService, TYPES.PartnerCommissionRepository],
  );
  container
    .bind<CommissionEngine>(TYPES.CommissionEngine)
    .toResolvedValue(
      (
        commissions: IPartnerCommissionRepository,
        billing: IBillingRepository,
        notifier: PartnerNotifier,
        ids: IIdGenerator,
        clock: IClock,
        logger: ILogger,
      ) => new CommissionEngine({ commissions, billing, notifier, ids, clock, logger }),
      [
        TYPES.PartnerCommissionRepository,
        TYPES.BillingRepository,
        TYPES.PartnerNotifier,
        TYPES.IdGenerator,
        TYPES.Clock,
        TYPES.Logger,
      ],
    );
  container.bind<PartnerCommissions>(TYPES.PartnerCommissions).toResolvedValue(
    (
      commissions: IPartnerCommissionRepository,
      partners: IPartnerRepository,
      billing: IBillingRepository,
      notifier: PartnerNotifier,
      renderer: IPdfRenderer,
      unitOfWork: IPlatformUnitOfWork,
      audit: IPlatformAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
      logger: ILogger,
    ) =>
      new PartnerCommissions({
        commissions,
        partners,
        billing,
        // Lazy: the documents come later in the container.
        documentIds: async (partnerId) =>
          (await container.get<PartnerDocuments>(TYPES.PartnerDocuments).list(partnerId)).map(
            (f) => f.id,
          ),
        notifier,
        renderer,
        unitOfWork,
        audit,
        requestContext,
        ids,
        clock,
        logger,
      }),
    [
      TYPES.PartnerCommissionRepository,
      TYPES.PartnerRepository,
      TYPES.BillingRepository,
      TYPES.PartnerNotifier,
      TYPES.PdfRenderer,
      TYPES.PlatformUnitOfWork,
      TYPES.PlatformAuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
      TYPES.Logger,
    ],
  );

  // --- Enterprise licence (P4-4) ---
  container.bind<EnterpriseQuotes>(TYPES.EnterpriseQuotes).toResolvedValue(
    (
      quotes: IEnterpriseQuoteRepository,
      billing: IBillingRepository,
      subscriptions: SubscriptionAdministration,
      notices: BillingNotices,
      unitOfWork: IPlatformUnitOfWork,
      audit: IPlatformAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
      logger: ILogger,
      renderer: IPdfRenderer,
    ) =>
      new EnterpriseQuotes({
        quotes,
        billing,
        subscriptions,
        documents: new BillingDocuments({ renderer, clock }),
        notices,
        unitOfWork,
        audit,
        requestContext,
        ids,
        clock,
        logger,
      }),
    [
      TYPES.EnterpriseQuoteRepository,
      TYPES.BillingRepository,
      TYPES.SubscriptionAdministration,
      TYPES.BillingNotices,
      TYPES.PlatformUnitOfWork,
      TYPES.PlatformAuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
      TYPES.Logger,
      TYPES.PdfRenderer,
    ],
  );

  // --- Reference data and settings (currencies, tax, FX, expense categories, vehicles) ---
  platformRepository<IReferenceData>(TYPES.ReferenceData, (p) => new PostgresReferenceData(p));
  tenantRepository<ITenantReferenceData>(
    TYPES.TenantReferenceData,
    (tx) => new PostgresTenantReferenceData(tx),
  );
  tenantRepository<ICurrencyUsage>(TYPES.CurrencyUsage, (tx) => new PostgresCurrencyUsage(tx));
  container.bind<CurrencySettingsService>(TYPES.CurrencySettingsService).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      organisation: IOrganisationSettings,
      usage: ICurrencyUsage,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
    ) =>
      new CurrencySettingsService({
        unitOfWork,
        organisation,
        usage,
        auditTrail,
        requestContext,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.OrganisationSettings,
      TYPES.CurrencyUsage,
      TYPES.AuditTrail,
      TYPES.RequestContext,
    ],
  );
  const tenantReferenceDeps = (): [symbol, symbol, symbol, symbol, symbol, symbol] => [
    TYPES.UnitOfWork,
    TYPES.OrganisationSettings,
    TYPES.TenantReferenceData,
    TYPES.AuditTrail,
    TYPES.RequestContext,
    TYPES.IdGenerator,
  ];
  type TenantReferenceArgs = [
    IUnitOfWork,
    IOrganisationSettings,
    ITenantReferenceData,
    IAuditTrail,
    IRequestContext,
    IIdGenerator,
  ];
  const referenceDeps = (
    ...[unitOfWork, organisation, reference, auditTrail, requestContext, ids]: TenantReferenceArgs
  ) => ({ unitOfWork, organisation, reference, auditTrail, requestContext, ids });
  container
    .bind<TaxAdministration>(TYPES.TaxAdministration)
    .toResolvedValue(
      (...args: TenantReferenceArgs) => new TaxAdministration(referenceDeps(...args)),
      tenantReferenceDeps(),
    );
  container
    .bind<FxRateBook>(TYPES.FxRateBook)
    .toResolvedValue(
      (...args: TenantReferenceArgs) => new FxRateBook(referenceDeps(...args)),
      tenantReferenceDeps(),
    );
  container
    .bind<ExpenseCategoryAdministration>(TYPES.ExpenseCategoryAdministration)
    .toResolvedValue(
      (...args: [...TenantReferenceArgs, ILedger]) =>
        new ExpenseCategoryAdministration({
          ...referenceDeps(...(args.slice(0, 6) as TenantReferenceArgs)),
          ledger: args[6],
        }),
      [...tenantReferenceDeps(), TYPES.Ledger],
    );
  container
    .bind<VehicleCatalogue>(TYPES.VehicleCatalogue)
    .toResolvedValue(
      (
        reference: IReferenceData,
        unitOfWork: IPlatformUnitOfWork,
        audit: IPlatformAuditTrail,
        requestContext: IRequestContext,
      ) => new VehicleCatalogue({ reference, unitOfWork, audit, requestContext }),
      [
        TYPES.ReferenceData,
        TYPES.PlatformUnitOfWork,
        TYPES.PlatformAuditTrail,
        TYPES.RequestContext,
      ],
    );
  container
    .bind<DocumentNumbering>(TYPES.DocumentNumbering)
    .toResolvedValue(
      (organisation: IOrganisationSettings, sequences: ISequenceGenerator) =>
        new DocumentNumbering({ organisation, sequences }),
      [TYPES.OrganisationSettings, TYPES.SequenceGenerator],
    );

  // --- Vehicles (register, status, documents, odometer, photos, groups, import/export) ---
  tenantRepository<PostgresVehicleRepository>(
    TYPES.VehicleRepository,
    (tx) => new PostgresVehicleRepository(tx),
  );
  container
    .bind<IVehicleQueries>(TYPES.VehicleQueries)
    .toResolvedValue(
      (repository: PostgresVehicleRepository) => repository,
      [TYPES.VehicleRepository],
    );
  tenantRepository<IVehicleDocuments>(
    TYPES.VehicleDocumentRecords,
    (tx) => new PostgresVehicleDocuments(tx),
  );
  tenantRepository<IOdometerReadings>(
    TYPES.OdometerReadings,
    (tx) => new PostgresOdometerReadings(tx),
  );
  tenantRepository<IVehicleGroups>(TYPES.VehicleGroups, (tx) => new PostgresVehicleGroups(tx));
  tenantRepository<IVehicleSettingsStore>(
    TYPES.VehicleSettingsStore,
    (tx) => new PostgresVehicleSettingsStore(tx),
  );
  container
    .bind<VehicleAccess>(TYPES.VehicleAccess)
    .toResolvedValue(
      (vehicles: IVehicleRepository, branches: IBranches, policy: AuthorizationPolicy) =>
        new VehicleAccess({ vehicles, branches, policy }),
      [TYPES.VehicleRepository, TYPES.Branches, TYPES.AuthorizationPolicy],
    );
  container.bind<VehicleRegistry>(TYPES.VehicleRegistry).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      repository: PostgresVehicleRepository,
      groups: IVehicleGroups,
      odometer: IOdometerReadings,
      settings: IVehicleSettingsStore,
      organisation: IOrganisationSettings,
      reference: IReferenceData,
      numbering: DocumentNumbering,
      access: VehicleAccess,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
      assignments: PostgresAssignmentRepository,
    ) =>
      new VehicleRegistry({
        unitOfWork,
        vehicles: repository,
        queries: repository,
        groups,
        odometer,
        settings,
        organisation,
        reference,
        numbering,
        access,
        auditTrail,
        requestContext,
        ids,
        clock,
        assignments,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.VehicleRepository,
      TYPES.VehicleGroups,
      TYPES.OdometerReadings,
      TYPES.VehicleSettingsStore,
      TYPES.OrganisationSettings,
      TYPES.ReferenceData,
      TYPES.DocumentNumbering,
      TYPES.VehicleAccess,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
      TYPES.AssignmentRepository,
    ],
  );
  container.bind<VehicleDocuments>(TYPES.VehicleDocuments).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      documents: IVehicleDocuments,
      queries: IVehicleQueries,
      settings: IVehicleSettingsStore,
      organisation: IOrganisationSettings,
      access: VehicleAccess,
      files: FileService,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new VehicleDocuments({
        unitOfWork,
        documents,
        queries,
        settings,
        organisation,
        access,
        files: new OwnedDocuments(files, "vehicle_document", "vehicle_document", 5),
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.VehicleDocumentRecords,
      TYPES.VehicleQueries,
      TYPES.VehicleSettingsStore,
      TYPES.OrganisationSettings,
      TYPES.VehicleAccess,
      TYPES.TenantFileService,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<OdometerLog>(TYPES.OdometerLog).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      vehicles: IVehicleRepository,
      readings: IOdometerReadings,
      access: VehicleAccess,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new OdometerLog({
        unitOfWork,
        vehicles,
        readings,
        access,
        auditTrail,
        requestContext,
        ids,
        clock,
        // Resolved late: the due engine sits above the vehicle services.
        serviceDue: {
          vehicleRead: (vehicleId) =>
            container.get<ServiceSchedule>(TYPES.ServiceSchedule).vehicleRead(vehicleId),
        },
      }),
    [
      TYPES.UnitOfWork,
      TYPES.VehicleRepository,
      TYPES.OdometerReadings,
      TYPES.VehicleAccess,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<VehiclePhotos>(TYPES.VehiclePhotos).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      vehicles: IVehicleRepository,
      access: VehicleAccess,
      files: FileService,
      clock: IClock,
    ) =>
      new VehiclePhotos({
        unitOfWork,
        vehicles,
        access,
        photos: new OwnedDocuments(files, "vehicle_photo", "vehicle", 30),
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.VehicleRepository,
      TYPES.VehicleAccess,
      TYPES.TenantFileService,
      TYPES.Clock,
    ],
  );
  container.bind<VehicleGroupAdministration>(TYPES.VehicleGroupAdministration).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      groups: IVehicleGroups,
      vehicles: IVehicleRepository,
      access: VehicleAccess,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new VehicleGroupAdministration({
        unitOfWork,
        groups,
        vehicles,
        access,
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.VehicleGroups,
      TYPES.VehicleRepository,
      TYPES.VehicleAccess,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<VehicleImportExport>(TYPES.VehicleImportExport).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      registry: VehicleRegistry,
      queries: IVehicleQueries,
      groups: IVehicleGroups,
      branches: IBranches,
      settings: IVehicleSettingsStore,
      organisation: IOrganisationSettings,
      reference: IReferenceData,
      access: VehicleAccess,
    ) =>
      new VehicleImportExport({
        unitOfWork,
        registry,
        queries,
        groups,
        branches,
        settings,
        organisation,
        reference,
        access,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.VehicleRegistry,
      TYPES.VehicleQueries,
      TYPES.VehicleGroups,
      TYPES.Branches,
      TYPES.VehicleSettingsStore,
      TYPES.OrganisationSettings,
      TYPES.ReferenceData,
      TYPES.VehicleAccess,
    ],
  );
  container.bind<VehicleOverview>(TYPES.VehicleOverview).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      access: VehicleAccess,
      registry: VehicleRegistry,
      documents: VehicleDocuments,
      photos: VehiclePhotos,
      queries: IVehicleQueries,
      assignments: PostgresAssignmentRepository,
      branches: IBranches,
      clock: IClock,
    ) =>
      new VehicleOverview({
        unitOfWork,
        access,
        registry,
        documents,
        photos,
        queries,
        assignments,
        branches,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.VehicleAccess,
      TYPES.VehicleRegistry,
      TYPES.VehicleDocuments,
      TYPES.VehiclePhotos,
      TYPES.VehicleQueries,
      TYPES.AssignmentRepository,
      TYPES.Branches,
      TYPES.Clock,
    ],
  );
  container
    .bind<VehicleSettingsService>(TYPES.VehicleSettingsService)
    .toResolvedValue(
      (
        unitOfWork: IUnitOfWork,
        settings: IVehicleSettingsStore,
        auditTrail: IAuditTrail,
        requestContext: IRequestContext,
      ) => new VehicleSettingsService({ unitOfWork, settings, auditTrail, requestContext }),
      [TYPES.UnitOfWork, TYPES.VehicleSettingsStore, TYPES.AuditTrail, TYPES.RequestContext],
    );

  // --- Parties (drivers, guarantors, customers, suppliers, identity documents) ---
  container
    .bind<BranchScope>(TYPES.BranchScope)
    .toResolvedValue(
      (branches: IBranches, policy: AuthorizationPolicy) => new BranchScope({ branches, policy }),
      [TYPES.Branches, TYPES.AuthorizationPolicy],
    );
  tenantRepository<PostgresDriverRepository>(
    TYPES.DriverRepository,
    (tx) => new PostgresDriverRepository(tx),
  );
  tenantRepository<PostgresCustomerRepository>(
    TYPES.CustomerRepository,
    (tx) => new PostgresCustomerRepository(tx),
  );
  tenantRepository<PostgresSupplierRepository>(
    TYPES.SupplierRepository,
    (tx) => new PostgresSupplierRepository(tx),
  );
  tenantRepository<IDriverGuarantors>(
    TYPES.DriverGuarantorRecords,
    (tx) => new PostgresDriverGuarantors(tx),
  );
  tenantRepository<IPartyDocuments>(
    TYPES.PartyDocumentRecords,
    (tx) => new PostgresPartyDocuments(tx),
  );
  tenantRepository<IPartyStatusHistory>(
    TYPES.PartyStatusHistory,
    (tx) => new PostgresPartyStatusHistory(tx),
  );
  tenantRepository<IDriverSettingsStore>(
    TYPES.DriverSettingsStore,
    (tx) => new PostgresDriverSettingsStore(tx),
  );
  container.bind<DriverAdministration>(TYPES.DriverAdministration).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      drivers: PostgresDriverRepository,
      guarantors: IDriverGuarantors,
      documents: IPartyDocuments,
      history: IPartyStatusHistory,
      settings: IDriverSettingsStore,
      assignments: PostgresAssignmentRepository,
      organisation: IOrganisationSettings,
      scope: BranchScope,
      numbering: DocumentNumbering,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new DriverAdministration({
        // Driver app access depends on driver administration: resolved on a status change.
        statusListeners: () => [container.get<DriverAppAccess>(TYPES.DriverAppAccess)],
        unitOfWork,
        drivers,
        queries: drivers,
        guarantors,
        documents,
        history,
        settings,
        assignments,
        organisation,
        scope,
        numbering,
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.DriverRepository,
      TYPES.DriverGuarantorRecords,
      TYPES.PartyDocumentRecords,
      TYPES.PartyStatusHistory,
      TYPES.DriverSettingsStore,
      TYPES.AssignmentRepository,
      TYPES.OrganisationSettings,
      TYPES.BranchScope,
      TYPES.DocumentNumbering,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<DriverGuarantors>(TYPES.DriverGuarantors).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      drivers: DriverAdministration,
      guarantors: IDriverGuarantors,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new DriverGuarantors({
        unitOfWork,
        drivers,
        guarantors,
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.DriverAdministration,
      TYPES.DriverGuarantorRecords,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<CustomerAdministration>(TYPES.CustomerAdministration).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      customers: PostgresCustomerRepository,
      history: IPartyStatusHistory,
      organisation: IOrganisationSettings,
      policy: AuthorizationPolicy,
      numbering: DocumentNumbering,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new CustomerAdministration({
        unitOfWork,
        customers,
        queries: customers,
        history,
        organisation,
        policy,
        numbering,
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.CustomerRepository,
      TYPES.PartyStatusHistory,
      TYPES.OrganisationSettings,
      TYPES.AuthorizationPolicy,
      TYPES.DocumentNumbering,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<SupplierAdministration>(TYPES.SupplierAdministration).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      suppliers: PostgresSupplierRepository,
      numbering: DocumentNumbering,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new SupplierAdministration({
        unitOfWork,
        suppliers,
        queries: suppliers,
        numbering,
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.SupplierRepository,
      TYPES.DocumentNumbering,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<PartyDocuments>(TYPES.PartyDocuments).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      documents: IPartyDocuments,
      drivers: DriverAdministration,
      guarantors: DriverGuarantors,
      customers: CustomerAdministration,
      policy: AuthorizationPolicy,
      files: FileService,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new PartyDocuments({
        unitOfWork,
        documents,
        drivers,
        guarantors,
        customers,
        policy,
        files: new OwnedDocuments(files, "party_document", "party_document", 5),
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.PartyDocumentRecords,
      TYPES.DriverAdministration,
      TYPES.DriverGuarantors,
      TYPES.CustomerAdministration,
      TYPES.AuthorizationPolicy,
      TYPES.TenantFileService,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container
    .bind<DriverSettingsService>(TYPES.DriverSettingsService)
    .toResolvedValue(
      (
        unitOfWork: IUnitOfWork,
        settings: IDriverSettingsStore,
        auditTrail: IAuditTrail,
        requestContext: IRequestContext,
      ) => new DriverSettingsService({ unitOfWork, settings, auditTrail, requestContext }),
      [TYPES.UnitOfWork, TYPES.DriverSettingsStore, TYPES.AuditTrail, TYPES.RequestContext],
    );

  // --- Assignments (vehicle ↔ driver, handover checklist, remittance terms) ---
  tenantRepository<PostgresAssignmentRepository>(
    TYPES.AssignmentRepository,
    (tx) => new PostgresAssignmentRepository(tx),
  );
  tenantRepository<IAssignmentSettingsStore>(
    TYPES.AssignmentSettingsStore,
    (tx) => new PostgresAssignmentSettingsStore(tx),
  );
  container.bind<VehicleAssignments>(TYPES.VehicleAssignments).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      assignments: PostgresAssignmentRepository,
      settings: IAssignmentSettingsStore,
      vehicles: VehicleAccess,
      registry: VehicleRegistry,
      odometer: OdometerLog,
      documents: VehicleDocuments,
      drivers: DriverAdministration,
      organisation: IOrganisationSettings,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new VehicleAssignments({
        unitOfWork,
        assignments,
        queries: assignments,
        settings,
        vehicles,
        registry,
        odometer,
        documents,
        drivers,
        organisation,
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.AssignmentRepository,
      TYPES.AssignmentSettingsStore,
      TYPES.VehicleAccess,
      TYPES.VehicleRegistry,
      TYPES.OdometerLog,
      TYPES.VehicleDocuments,
      TYPES.DriverAdministration,
      TYPES.OrganisationSettings,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container
    .bind<AssignmentSettingsService>(TYPES.AssignmentSettingsService)
    .toResolvedValue(
      (
        unitOfWork: IUnitOfWork,
        settings: IAssignmentSettingsStore,
        auditTrail: IAuditTrail,
        requestContext: IRequestContext,
      ) => new AssignmentSettingsService({ unitOfWork, settings, auditTrail, requestContext }),
      [TYPES.UnitOfWork, TYPES.AssignmentSettingsStore, TYPES.AuditTrail, TYPES.RequestContext],
    );

  // --- Finance (record only): ledger, invoices, payments, cash sessions ---
  container
    .bind<TenantCalendar>(TYPES.TenantCalendar)
    .toResolvedValue(
      (organisation: IOrganisationSettings, clock: IClock) =>
        new TenantCalendar({ organisation, clock }),
      [TYPES.OrganisationSettings, TYPES.Clock],
    );
  tenantRepository<ILedger>(TYPES.Ledger, (tx) => new PostgresLedger(tx));
  tenantRepository<IInvoiceRepository>(
    TYPES.InvoiceRepository,
    (tx) => new PostgresInvoiceRepository(tx),
  );
  tenantRepository<IPaymentRepository>(
    TYPES.PaymentRepository,
    (tx) => new PostgresPaymentRepository(tx),
  );
  tenantRepository<ICashSessionRepository>(
    TYPES.CashSessionRepository,
    (tx) => new PostgresCashSessionRepository(tx),
  );
  tenantRepository<IFinanceQueries>(TYPES.FinanceQueries, (tx) => new PostgresFinanceQueries(tx));
  tenantRepository<IPartyDirectory>(TYPES.PartyDirectory, (tx) => new PostgresPartyDirectory(tx));
  tenantRepository<IFinanceSettingsStore>(
    TYPES.FinanceSettingsStore,
    (tx) => new PostgresFinanceSettingsStore(tx),
  );
  container
    .bind<LedgerPosting>(TYPES.LedgerPosting)
    .toResolvedValue(
      (
        ledger: ILedger,
        numbering: DocumentNumbering,
        organisation: IOrganisationSettings,
        clock: IClock,
      ) => new LedgerPosting({ ledger, numbering, organisation, clock }),
      [TYPES.Ledger, TYPES.DocumentNumbering, TYPES.OrganisationSettings, TYPES.Clock],
    );
  container
    .bind<FinanceContext>(TYPES.FinanceContext)
    .toResolvedValue(
      (
        currencies: CurrencySettingsService,
        reference: ITenantReferenceData,
        parties: IPartyDirectory,
      ) => new FinanceContext({ currencies, reference, parties }),
      [TYPES.CurrencySettingsService, TYPES.TenantReferenceData, TYPES.PartyDirectory],
    );
  container.bind<Invoicing>(TYPES.Invoicing).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      invoices: IInvoiceRepository,
      queries: IFinanceQueries,
      ledger: ILedger,
      posting: LedgerPosting,
      context: FinanceContext,
      settings: IFinanceSettingsStore,
      reference: ITenantReferenceData,
      organisation: IOrganisationSettings,
      vehicles: IVehicleRepository,
      scope: BranchScope,
      numbering: DocumentNumbering,
      calendar: TenantCalendar,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new Invoicing({
        unitOfWork,
        invoices,
        queries,
        ledger,
        posting,
        context,
        settings,
        reference,
        organisation,
        vehicles,
        scope,
        numbering,
        calendar,
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.InvoiceRepository,
      TYPES.FinanceQueries,
      TYPES.Ledger,
      TYPES.LedgerPosting,
      TYPES.FinanceContext,
      TYPES.FinanceSettingsStore,
      TYPES.TenantReferenceData,
      TYPES.OrganisationSettings,
      TYPES.VehicleRepository,
      TYPES.BranchScope,
      TYPES.DocumentNumbering,
      TYPES.TenantCalendar,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<PaymentRecording>(TYPES.PaymentRecording).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      payments: IPaymentRepository,
      invoices: IInvoiceRepository,
      sessions: ICashSessionRepository,
      queries: IFinanceQueries,
      ledger: ILedger,
      posting: LedgerPosting,
      context: FinanceContext,
      settings: IFinanceSettingsStore,
      organisation: IOrganisationSettings,
      vehicles: IVehicleRepository,
      scope: BranchScope,
      numbering: DocumentNumbering,
      calendar: TenantCalendar,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
      expenseRepository: IExpenseRepository,
      remittanceStore: PostgresRemittances,
      calendarForListeners: TenantCalendar,
      postingForListeners: LedgerPosting,
      workpayAgreements: IWorkPayAgreementRepository,
    ) => {
      // Collections records through payment recording: resolved when finance calls back.
      const collections = () => container.get<WorkPayCollections>(TYPES.WorkPayCollections);
      // Rental deposits: resolved when finance calls back.
      const rentalAccounts = () => container.get<RentalAccounts>(TYPES.RentalAccounts);
      const rentalDeposits = {
        sourceType: DEPOSIT_SOURCE,
        paymentReversed: (_bookingId: string, paymentId: string) =>
          rentalAccounts().depositPaymentReversed(paymentId),
        describe: (bookingId: string, paymentId: string) =>
          rentalAccounts().depositPurpose(bookingId, paymentId),
      };
      const workpayInstalments = {
        sourceType: "workpay_payment",
        paymentReversed: (sourceId: string, paymentId: string) =>
          collections().paymentReversed(sourceId, paymentId),
        describe: (sourceId: string, paymentId: string) =>
          collections().describe(sourceId, paymentId),
      };
      return new PaymentRecording({
        unitOfWork,
        payments,
        invoices,
        sessions,
        queries,
        ledger,
        posting,
        context,
        settings,
        organisation,
        vehicles,
        scope,
        numbering,
        calendar,
        auditTrail,
        requestContext,
        ids,
        clock,
        reversalListeners: [
          new ExpensePaymentListener({
            expenses: expenseRepository,
            posting: postingForListeners,
            calendar: calendarForListeners,
            clock,
          }),
          new SupplierPaymentListener({
            expenses: expenseRepository,
            posting: postingForListeners,
            calendar: calendarForListeners,
            clock,
          }),
          new RemittancePaymentListener({
            remittances: remittanceStore,
            records: remittanceStore,
            posting: postingForListeners,
            calendar: calendarForListeners,
            // Remittances depends on payment recording: resolved when a reversal happens.
            book: () => container.get<Remittances>(TYPES.Remittances),
            clock,
          }),
          new WorkPayDeposits({ agreements: workpayAgreements, payments, clock }),
          workpayInstalments,
          rentalDeposits,
        ],
        purposes: [
          new RemittancePaymentPurpose({ remittances: remittanceStore, records: remittanceStore }),
          new WorkPayDeposits({ agreements: workpayAgreements, payments, clock }),
          workpayInstalments,
          rentalDeposits,
        ],
      });
    },
    [
      TYPES.UnitOfWork,
      TYPES.PaymentRepository,
      TYPES.InvoiceRepository,
      TYPES.CashSessionRepository,
      TYPES.FinanceQueries,
      TYPES.Ledger,
      TYPES.LedgerPosting,
      TYPES.FinanceContext,
      TYPES.FinanceSettingsStore,
      TYPES.OrganisationSettings,
      TYPES.VehicleRepository,
      TYPES.BranchScope,
      TYPES.DocumentNumbering,
      TYPES.TenantCalendar,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
      TYPES.ExpenseRepository,
      TYPES.RemittanceStore,
      TYPES.TenantCalendar,
      TYPES.LedgerPosting,
      TYPES.WorkPayAgreementRepository,
    ],
  );
  container.bind<CashSessions>(TYPES.CashSessions).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      sessions: ICashSessionRepository,
      queries: IFinanceQueries,
      posting: LedgerPosting,
      scope: BranchScope,
      calendar: TenantCalendar,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new CashSessions({
        unitOfWork,
        sessions,
        queries,
        posting,
        scope,
        calendar,
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.CashSessionRepository,
      TYPES.FinanceQueries,
      TYPES.LedgerPosting,
      TYPES.BranchScope,
      TYPES.TenantCalendar,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  tenantRepository<IIntegrityChecks>(
    TYPES.IntegrityChecks,
    (tx) => new PostgresIntegrityChecks(() => tx.current()),
  );
  container.bind<LedgerViews>(TYPES.LedgerViews).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      ledger: ILedger,
      posting: LedgerPosting,
      context: FinanceContext,
      calendar: TenantCalendar,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      integrity: IIntegrityChecks,
    ) =>
      new LedgerViews({
        unitOfWork,
        ledger,
        posting,
        context,
        calendar,
        auditTrail,
        requestContext,
        ids,
        integrity,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.Ledger,
      TYPES.LedgerPosting,
      TYPES.FinanceContext,
      TYPES.TenantCalendar,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.IntegrityChecks,
    ],
  );
  container
    .bind<FinanceSettingsService>(TYPES.FinanceSettingsService)
    .toResolvedValue(
      (
        unitOfWork: IUnitOfWork,
        settings: IFinanceSettingsStore,
        auditTrail: IAuditTrail,
        requestContext: IRequestContext,
      ) => new FinanceSettingsService({ unitOfWork, settings, auditTrail, requestContext }),
      [TYPES.UnitOfWork, TYPES.FinanceSettingsStore, TYPES.AuditTrail, TYPES.RequestContext],
    );

  // --- Expenses: split, approval, payment, receipts, recurring, budgets, fuel ---
  tenantRepository<PostgresExpenseRepository>(
    TYPES.ExpenseRepository,
    (tx) => new PostgresExpenseRepository(tx),
  );
  tenantRepository<IApprovalRules>(TYPES.ApprovalRules, (tx) => new PostgresApprovalRules(tx));
  tenantRepository<IBudgets>(TYPES.Budgets, (tx) => new PostgresBudgets(tx));
  tenantRepository<IRecurringExpenses>(
    TYPES.RecurringExpenseStore,
    (tx) => new PostgresRecurringExpenses(tx),
  );
  tenantRepository<IFuelLogs>(TYPES.FuelLogStore, (tx) => new PostgresFuelLogs(tx));
  tenantRepository<IExpenseSettingsStore>(
    TYPES.ExpenseSettingsStore,
    (tx) => new PostgresExpenseSettingsStore(tx),
  );
  container.bind<Expenses>(TYPES.Expenses).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      expenses: PostgresExpenseRepository,
      rules: IApprovalRules,
      settings: IExpenseSettingsStore,
      reference: ITenantReferenceData,
      organisation: IOrganisationSettings,
      vehicles: IVehicleRepository,
      parties: IPartyDirectory,
      posting: LedgerPosting,
      context: FinanceContext,
      payments: PaymentRecording,
      files: FileService,
      policy: AuthorizationPolicy,
      scope: BranchScope,
      numbering: DocumentNumbering,
      calendar: TenantCalendar,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
      driverCosts: WorkPayDriverCosts,
    ) =>
      new Expenses({
        unitOfWork,
        expenses,
        queries: expenses,
        rules,
        settings,
        reference,
        organisation,
        vehicles,
        parties,
        posting,
        context,
        payments,
        receipts: new OwnedDocuments(files, "expense_receipt", "expense", 5),
        policy,
        scope,
        numbering,
        calendar,
        auditTrail,
        requestContext,
        ids,
        clock,
        driverCosts,
        // Purchases depend on expenses: resolved when a purchase cost posts.
        sourceHooks: [
          new PurchaseCostHook({
            purchases: container.get<IPurchases>(TYPES.PurchaseRepository),
            book: () => container.get<Purchases>(TYPES.Purchases),
          }),
        ],
      }),
    [
      TYPES.UnitOfWork,
      TYPES.ExpenseRepository,
      TYPES.ApprovalRules,
      TYPES.ExpenseSettingsStore,
      TYPES.TenantReferenceData,
      TYPES.OrganisationSettings,
      TYPES.VehicleRepository,
      TYPES.PartyDirectory,
      TYPES.LedgerPosting,
      TYPES.FinanceContext,
      TYPES.PaymentRecording,
      TYPES.TenantFileService,
      TYPES.AuthorizationPolicy,
      TYPES.BranchScope,
      TYPES.DocumentNumbering,
      TYPES.TenantCalendar,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
      TYPES.WorkPayDriverCosts,
    ],
  );
  container.bind<FuelLogs>(TYPES.FuelLogs).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      logs: IFuelLogs,
      expenses: Expenses,
      expenseRepository: PostgresExpenseRepository,
      settings: IExpenseSettingsStore,
      reference: ITenantReferenceData,
      vehicles: VehicleAccess,
      odometer: OdometerLog,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
      anomalies: FuelAnomalies,
    ) =>
      new FuelLogs({
        unitOfWork,
        logs,
        expenses,
        expenseRepository,
        settings,
        reference,
        vehicles,
        odometer,
        auditTrail,
        requestContext,
        ids,
        clock,
        anomalies,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.FuelLogStore,
      TYPES.Expenses,
      TYPES.ExpenseRepository,
      TYPES.ExpenseSettingsStore,
      TYPES.TenantReferenceData,
      TYPES.VehicleAccess,
      TYPES.OdometerLog,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
      TYPES.FuelAnomalies,
    ],
  );
  container.bind<ExpenseAdministration>(TYPES.ExpenseAdministration).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      rules: IApprovalRules,
      budgets: IBudgets,
      queries: PostgresExpenseRepository,
      settings: IExpenseSettingsStore,
      posting: LedgerPosting,
      calendar: TenantCalendar,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new ExpenseAdministration({
        unitOfWork,
        rules,
        budgets,
        queries,
        settings,
        posting,
        calendar,
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.ApprovalRules,
      TYPES.Budgets,
      TYPES.ExpenseRepository,
      TYPES.ExpenseSettingsStore,
      TYPES.LedgerPosting,
      TYPES.TenantCalendar,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<RecurringExpenses>(TYPES.RecurringExpenses).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      recurring: IRecurringExpenses,
      expenses: Expenses,
      scope: BranchScope,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
      logger: ILogger,
    ) =>
      new RecurringExpenses({
        unitOfWork,
        recurring,
        expenses,
        scope,
        auditTrail,
        requestContext,
        ids,
        clock,
        logger,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.RecurringExpenseStore,
      TYPES.Expenses,
      TYPES.BranchScope,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
      TYPES.Logger,
    ],
  );
  container.bind<ITenantDailyTask[]>(TYPES.TenantDailyTasks).toResolvedValue(
    (
      recurring: RecurringExpenses,
      remittances: RemittanceScheduler,
      stats: VehicleStatsBuilder,
      documents: Documents,
      signing: DocumentSigning,
      workpayArrears: WorkPayArrears,
      serviceDue: ServiceSchedule,
      maintenanceAlerts: MaintenanceAlerts,
      purchaseAlerts: PurchaseAlerts,
      stockAlerts: StockAlerts,
    ) =>
      // Stats after the money tasks: they read what those posted.
      [
        recurring,
        remittances,
        workpayArrears,
        stats,
        serviceDue,
        maintenanceAlerts,
        purchaseAlerts,
        stockAlerts,
        new PendingDocumentRenders(documents),
        new SigningMaintenance(signing),
      ],
    [
      TYPES.RecurringExpenses,
      TYPES.RemittanceScheduler,
      TYPES.VehicleStatsBuilder,
      TYPES.Documents,
      TYPES.DocumentSigning,
      TYPES.WorkPayArrears,
      TYPES.ServiceSchedule,
      TYPES.MaintenanceAlerts,
      TYPES.PurchaseAlerts,
      TYPES.StockAlerts,
    ],
  );

  // --- Remittances and the driver ledger ---
  tenantRepository<PostgresRemittances>(TYPES.RemittanceStore, (tx) => new PostgresRemittances(tx));
  tenantRepository<IOperationsQueries>(
    TYPES.OperationsQueries,
    (tx) => new PostgresOperationsQueries(tx),
  );
  tenantRepository<IRemittanceSettingsStore>(
    TYPES.RemittanceSettingsStore,
    (tx) => new PostgresRemittanceSettingsStore(tx),
  );
  container.bind<Remittances>(TYPES.Remittances).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      store: PostgresRemittances,
      settings: IRemittanceSettingsStore,
      assignments: PostgresAssignmentRepository,
      payments: PaymentRecording,
      posting: LedgerPosting,
      scope: BranchScope,
      numbering: DocumentNumbering,
      calendar: TenantCalendar,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new Remittances({
        unitOfWork,
        remittances: store,
        records: store,
        settings,
        assignments,
        payments,
        posting,
        scope,
        numbering,
        calendar,
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.RemittanceStore,
      TYPES.RemittanceSettingsStore,
      TYPES.AssignmentRepository,
      TYPES.PaymentRecording,
      TYPES.LedgerPosting,
      TYPES.BranchScope,
      TYPES.DocumentNumbering,
      TYPES.TenantCalendar,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<RemittanceScheduler>(TYPES.RemittanceScheduler).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      store: PostgresRemittances,
      settings: IRemittanceSettingsStore,
      organisation: IOrganisationSettings,
      book: Remittances,
      posting: LedgerPosting,
      ids: IIdGenerator,
      clock: IClock,
      logger: ILogger,
    ) =>
      new RemittanceScheduler({
        unitOfWork,
        remittances: store,
        records: store,
        settings,
        organisation,
        book,
        posting,
        ids,
        clock,
        logger,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.RemittanceStore,
      TYPES.RemittanceSettingsStore,
      TYPES.OrganisationSettings,
      TYPES.Remittances,
      TYPES.LedgerPosting,
      TYPES.IdGenerator,
      TYPES.Clock,
      TYPES.Logger,
    ],
  );
  container.bind<DriverLedger>(TYPES.DriverLedger).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      ledger: ILedger,
      store: PostgresRemittances,
      drivers: DriverAdministration,
      posting: LedgerPosting,
      calendar: TenantCalendar,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new DriverLedger({
        unitOfWork,
        ledger,
        records: store,
        drivers,
        posting,
        calendar,
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.Ledger,
      TYPES.RemittanceStore,
      TYPES.DriverAdministration,
      TYPES.LedgerPosting,
      TYPES.TenantCalendar,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container
    .bind<OperationsBoard>(TYPES.OperationsBoard)
    .toResolvedValue(
      (
        unitOfWork: IUnitOfWork,
        queries: IOperationsQueries,
        settings: IRemittanceSettingsStore,
        drivers: DriverAdministration,
        posting: LedgerPosting,
        scope: BranchScope,
        calendar: TenantCalendar,
      ) =>
        new OperationsBoard({ unitOfWork, queries, settings, drivers, posting, scope, calendar }),
      [
        TYPES.UnitOfWork,
        TYPES.OperationsQueries,
        TYPES.RemittanceSettingsStore,
        TYPES.DriverAdministration,
        TYPES.LedgerPosting,
        TYPES.BranchScope,
        TYPES.TenantCalendar,
      ],
    );
  container
    .bind<RemittanceSettingsService>(TYPES.RemittanceSettingsService)
    .toResolvedValue(
      (
        unitOfWork: IUnitOfWork,
        settings: IRemittanceSettingsStore,
        auditTrail: IAuditTrail,
        requestContext: IRequestContext,
      ) => new RemittanceSettingsService({ unitOfWork, settings, auditTrail, requestContext }),
      [TYPES.UnitOfWork, TYPES.RemittanceSettingsStore, TYPES.AuditTrail, TYPES.RequestContext],
    );

  // --- Document engine ---
  tenantRepository<IDocumentTemplateRepository>(
    TYPES.DocumentTemplateRepository,
    (tx) => new PostgresDocumentTemplates(tx),
  );
  tenantRepository<IDocumentRepository>(
    TYPES.DocumentRepository,
    (tx) => new PostgresIssuedDocuments(tx),
  );
  tenantRepository<IDocumentEvents>(TYPES.DocumentEvents, (tx) => new PostgresDocumentEvents(tx));
  container
    .bind<IDocumentRenderQueue>(TYPES.DocumentRenderQueue)
    .toResolvedValue(
      (tx: PostgresTransactionContext, tenantContext: ITenantContext, queue: IJobQueue) =>
        new QueuedDocumentRendering(tx, tenantContext, queue),
      [TYPES.PostgresTransactionContext, TYPES.TenantContext, TYPES.JobQueue],
    );
  tenantRepository<IDocumentSigners>(
    TYPES.DocumentSigners,
    (tx) => new PostgresDocumentSigners(tx),
  );
  tenantRepository<IDocumentSigningLinks>(
    TYPES.DocumentSigningLinks,
    (tx) => new PostgresDocumentSigningLinks(tx),
  );
  tenantRepository<ISignerParties>(TYPES.SignerParties, (tx) => new PostgresSignerParties(tx));
  tenantRepository<IDocumentSettingsStore>(
    TYPES.DocumentSettingsStore,
    (tx) => new PostgresDocumentSettingsStore(tx),
  );
  container.bind<DocumentPdfComposer>(TYPES.DocumentPdfComposer).toResolvedValue(
    (
      organisation: IOrganisationSettings,
      renderer: IPdfRenderer,
      storage: IObjectStorage,
      logger: ILogger,
    ) =>
      new DocumentPdfComposer({
        organisation,
        renderer,
        logo: new BusinessLogo({ storage, logger }),
      }),
    [TYPES.OrganisationSettings, TYPES.PdfRenderer, TYPES.ObjectStorage, TYPES.Logger],
  );
  container.bind<SignatureRequests>(TYPES.SignatureRequests).toResolvedValue(
    (
      links: IDocumentSigningLinks,
      driverLinks: IDriverAppLinks,
      notifier: Notifier,
      notificationSettings: INotificationSettingsStore,
      documentSettings: IDocumentSettingsStore,
      organisation: IOrganisationSettings,
      clock: IClock,
    ) =>
      new SignatureRequests({
        links,
        driverLinks,
        notifier,
        notificationSettings,
        documentSettings,
        organisation,
        clock,
        settings: { webAppUrl: config.public.webAppUrl },
      }),
    [
      TYPES.DocumentSigningLinks,
      TYPES.DriverAppLinks,
      TYPES.Notifier,
      TYPES.NotificationSettingsStore,
      TYPES.DocumentSettingsStore,
      TYPES.OrganisationSettings,
      TYPES.Clock,
    ],
  );
  container.bind<Documents>(TYPES.Documents).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      documents: IDocumentRepository,
      events: IDocumentEvents,
      templates: IDocumentTemplateRepository,
      renderQueue: IDocumentRenderQueue,
      organisation: IOrganisationSettings,
      numbering: DocumentNumbering,
      calendar: TenantCalendar,
      files: FileService,
      composer: DocumentPdfComposer,
      signers: IDocumentSigners,
      parties: ISignerParties,
      documentSettings: IDocumentSettingsStore,
      requests: SignatureRequests,
      scope: BranchScope,
      tenantContext: ITenantContext,
      directory: ITenantDirectory,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new Documents({
        unitOfWork,
        documents,
        events,
        templates,
        renderQueue,
        organisation,
        numbering,
        calendar,
        files,
        composer,
        signers,
        parties,
        documentSettings,
        requests,
        scope,
        tenantContext,
        directory,
        auditTrail,
        requestContext,
        ids,
        clock,
        settings: { webAppUrl: config.public.webAppUrl },
      }),
    [
      TYPES.UnitOfWork,
      TYPES.DocumentRepository,
      TYPES.DocumentEvents,
      TYPES.DocumentTemplateRepository,
      TYPES.DocumentRenderQueue,
      TYPES.OrganisationSettings,
      TYPES.DocumentNumbering,
      TYPES.TenantCalendar,
      TYPES.TenantFileService,
      TYPES.DocumentPdfComposer,
      TYPES.DocumentSigners,
      TYPES.SignerParties,
      TYPES.DocumentSettingsStore,
      TYPES.SignatureRequests,
      TYPES.BranchScope,
      TYPES.TenantContext,
      TYPES.TenantDirectory,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<DocumentSigning>(TYPES.DocumentSigning).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      documents: IDocumentRepository,
      issued: Documents,
      signers: IDocumentSigners,
      links: IDocumentSigningLinks,
      events: IDocumentEvents,
      settings: IDocumentSettingsStore,
      requests: SignatureRequests,
      composer: DocumentPdfComposer,
      files: FileService,
      driverLinks: IDriverAppLinks,
      issueOtp: IssueOtpChallenge,
      verifyOtp: VerifyOtpChallenge,
      deliveries: INotificationDeliveries,
      notificationSettings: INotificationSettingsStore,
      emails: NotificationService,
      organisation: IOrganisationSettings,
      scope: BranchScope,
      tenantContext: ITenantContext,
      requestContext: IRequestContext,
      clock: IClock,
      sealQueue: IDocumentRenderQueue,
    ) =>
      new DocumentSigning({
        unitOfWork,
        documents,
        issued,
        signers,
        links,
        events,
        settings,
        requests,
        composer,
        files,
        scans: new OwnedDocuments(files, "signed_paper_scan", "document", 20),
        driverLinks,
        issueOtp,
        verifyOtp,
        deliveries,
        notificationSettings,
        emails,
        organisation,
        qr: new QrcodeSvgRenderer(),
        scope,
        tenantContext,
        requestContext,
        clock,
        sealQueue,
        // Work & Pay issues through documents: resolved when a letter is fully signed.
        signedListeners: [
          {
            documentType: "transfer_letter",
            fullySigned: (document) =>
              container.get<WorkPayTransfers>(TYPES.WorkPayTransfers).fullySigned(document),
          },
          // Rentals: the booking records its agreement and return note as signed.
          ...(["rental_agreement", "rental_return"] as const).map((documentType) => ({
            documentType,
            fullySigned: (document: IssuedDocumentProps) =>
              container.get<RentalAgreements>(TYPES.RentalAgreements).fullySigned(document),
          })),
        ],
      }),
    [
      TYPES.UnitOfWork,
      TYPES.DocumentRepository,
      TYPES.Documents,
      TYPES.DocumentSigners,
      TYPES.DocumentSigningLinks,
      TYPES.DocumentEvents,
      TYPES.DocumentSettingsStore,
      TYPES.SignatureRequests,
      TYPES.DocumentPdfComposer,
      TYPES.TenantFileService,
      TYPES.DriverAppLinks,
      TYPES.IssueOtpChallenge,
      TYPES.VerifyOtpChallenge,
      TYPES.NotificationDeliveries,
      TYPES.NotificationSettingsStore,
      TYPES.NotificationService,
      TYPES.OrganisationSettings,
      TYPES.BranchScope,
      TYPES.TenantContext,
      TYPES.RequestContext,
      TYPES.Clock,
      TYPES.DocumentRenderQueue,
    ],
  );
  container
    .bind<DocumentSettingsService>(TYPES.DocumentSettingsService)
    .toResolvedValue(
      (
        unitOfWork: IUnitOfWork,
        settings: IDocumentSettingsStore,
        auditTrail: IAuditTrail,
        requestContext: IRequestContext,
      ) => new DocumentSettingsService({ unitOfWork, settings, auditTrail, requestContext }),
      [TYPES.UnitOfWork, TYPES.DocumentSettingsStore, TYPES.AuditTrail, TYPES.RequestContext],
    );
  container.bind<DocumentTemplates>(TYPES.DocumentTemplates).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      templates: IDocumentTemplateRepository,
      renderer: IPdfRenderer,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new DocumentTemplates({
        unitOfWork,
        templates,
        renderer,
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.DocumentTemplateRepository,
      TYPES.PdfRenderer,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<HandoverDocuments>(TYPES.HandoverDocuments).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      assignments: PostgresAssignmentRepository,
      vehicles: IVehicleRepository,
      drivers: PostgresDriverRepository,
      branches: IBranches,
      documents: Documents,
      posting: LedgerPosting,
      scope: BranchScope,
    ) =>
      new HandoverDocuments({
        unitOfWork,
        assignments,
        vehicles,
        drivers,
        branches,
        documents,
        posting,
        scope,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.AssignmentRepository,
      TYPES.VehicleRepository,
      TYPES.DriverRepository,
      TYPES.Branches,
      TYPES.Documents,
      TYPES.LedgerPosting,
      TYPES.BranchScope,
    ],
  );
  container
    .bind<IJobHandler[]>(TYPES.DocumentJobHandlers)
    .toResolvedValue(
      (documents: Documents, signing: DocumentSigning): IJobHandler[] => [
        new RenderDocument(documents),
        new SealDocument(signing),
      ],
      [TYPES.Documents, TYPES.DocumentSigning],
    );

  // --- Driver app, vehicle issues, PDFs ---
  tenantRepository<IDriverAppLinks>(TYPES.DriverAppLinks, (tx) => new PostgresDriverAppLinks(tx));
  tenantRepository<IVehicleIssueRepository>(
    TYPES.VehicleIssueRepository,
    (tx) => new PostgresVehicleIssues(tx),
  );
  container.bind<IPdfRenderer>(TYPES.PdfRenderer).toConstantValue(new PdfKitRenderer());
  container.bind<PrintedDocuments>(TYPES.PrintedDocuments).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      payments: PaymentRecording,
      ledger: DriverLedger,
      organisation: IOrganisationSettings,
      storage: IObjectStorage,
      renderer: IPdfRenderer,
      clock: IClock,
      logger: ILogger,
    ) =>
      new PrintedDocuments({
        unitOfWork,
        payments,
        ledger,
        organisation,
        logo: new BusinessLogo({ storage, logger }),
        renderer,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.PaymentRecording,
      TYPES.DriverLedger,
      TYPES.OrganisationSettings,
      TYPES.ObjectStorage,
      TYPES.PdfRenderer,
      TYPES.Clock,
      TYPES.Logger,
    ],
  );
  container.bind<VehicleIssues>(TYPES.VehicleIssues).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      issues: IVehicleIssueRepository,
      vehicles: VehicleAccess,
      files: FileService,
      scope: BranchScope,
      numbering: DocumentNumbering,
      notifier: Notifier,
      notificationSettings: INotificationSettingsStore,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new VehicleIssues({
        unitOfWork,
        issues,
        vehicles,
        photos: new OwnedDocuments(files, "vehicle_issue_photo", "vehicle_issue", 8),
        scope,
        numbering,
        notifier,
        notificationSettings,
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.VehicleIssueRepository,
      TYPES.VehicleAccess,
      TYPES.TenantFileService,
      TYPES.BranchScope,
      TYPES.DocumentNumbering,
      TYPES.Notifier,
      TYPES.NotificationSettingsStore,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<DriverAppAccess>(TYPES.DriverAppAccess).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      tenantContext: ITenantContext,
      drivers: DriverAdministration,
      links: IDriverAppLinks,
      users: ITenantUserRepository,
      memberships: IUserMemberships,
      roles: ITenantRoles,
      invitations: IUserInvitations,
      sessions: ITenantSessions,
      directory: IUserDirectory,
      permissionCache: IPermissionCache,
      organisation: IOrganisationSettings,
      notifications: NotificationService,
      deliveries: INotificationDeliveries,
      notificationSettings: INotificationSettingsStore,
      mobile: MobileConnect,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new DriverAppAccess({
        unitOfWork,
        tenantContext,
        drivers,
        links,
        users,
        memberships,
        roles,
        invitations,
        sessions,
        directory,
        permissionCache,
        organisation,
        notifications,
        deliveries,
        notificationSettings,
        qr: new QrcodeSvgRenderer(),
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
      TYPES.DriverAdministration,
      TYPES.DriverAppLinks,
      TYPES.TenantUserRepository,
      TYPES.UserMemberships,
      TYPES.TenantRoles,
      TYPES.UserInvitations,
      TYPES.TenantSessions,
      TYPES.UserDirectory,
      TYPES.PermissionCache,
      TYPES.OrganisationSettings,
      TYPES.NotificationService,
      TYPES.NotificationDeliveries,
      TYPES.NotificationSettingsStore,
      TYPES.MobileConnect,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<DriverApp>(TYPES.DriverApp).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      links: IDriverAppLinks,
      drivers: PostgresDriverRepository,
      vehicles: IVehicleRepository,
      assignments: PostgresAssignmentRepository,
      documents: VehicleDocuments,
      remittances: Remittances,
      ledger: DriverLedger,
      fuel: FuelLogs,
      issues: VehicleIssues,
      printed: PrintedDocuments,
      posting: LedgerPosting,
      calendar: TenantCalendar,
      workpay: WorkPayAgreements,
      transfers: WorkPayTransfers,
      workpayReports: WorkPayReports,
    ) =>
      new DriverApp({
        workpay,
        transfers,
        workpayReports,
        unitOfWork,
        links,
        drivers,
        vehicles,
        assignments,
        documents,
        remittances,
        ledger,
        fuel,
        issues,
        printed,
        posting,
        calendar,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.DriverAppLinks,
      TYPES.DriverRepository,
      TYPES.VehicleRepository,
      TYPES.AssignmentRepository,
      TYPES.VehicleDocuments,
      TYPES.Remittances,
      TYPES.DriverLedger,
      TYPES.FuelLogs,
      TYPES.VehicleIssues,
      TYPES.PrintedDocuments,
      TYPES.LedgerPosting,
      TYPES.TenantCalendar,
      TYPES.WorkPayAgreements,
      TYPES.WorkPayTransfers,
      TYPES.WorkPayReports,
    ],
  );

  // --- Work & Pay ---
  tenantRepository<IWorkPayTransfers>(
    TYPES.WorkPayTransferStore,
    (tx) => new PostgresWorkPayTransfers(tx),
  );
  tenantRepository<IWorkPayReporting>(
    TYPES.WorkPayReporting,
    (tx) => new PostgresWorkPayReporting(tx),
  );
  container.bind<WorkPayNotifications>(TYPES.WorkPayNotifications).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      settings: INotificationSettingsStore,
      workpaySettings: IWorkPaySettingsStore,
      organisation: IOrganisationSettings,
      reporting: IWorkPayReporting,
      drivers: PostgresDriverRepository,
      vehicles: IVehicleRepository,
      notifier: Notifier,
      posting: LedgerPosting,
      logger: ILogger,
    ) =>
      new WorkPayNotifications({
        unitOfWork,
        settings,
        workpaySettings,
        organisation,
        reporting,
        drivers,
        vehicles,
        notifier,
        posting,
        logger,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.NotificationSettingsStore,
      TYPES.WorkPaySettingsStore,
      TYPES.OrganisationSettings,
      TYPES.WorkPayReporting,
      TYPES.DriverRepository,
      TYPES.VehicleRepository,
      TYPES.Notifier,
      TYPES.LedgerPosting,
      TYPES.Logger,
    ],
  );
  // --- Rentals: classes, rate plans, extras, zones, promo codes, quotes (docs/07 §4) ---
  tenantRepository<IRentalRates>(TYPES.RentalRates, (tx) => new PostgresRentalRates(tx));
  tenantRepository<IVehicleBlocks>(TYPES.VehicleBlocks, (tx) => new PostgresVehicleBlocks(tx));
  tenantRepository<IRentalBookings>(
    TYPES.RentalBookingRepository,
    (tx) => new PostgresRentalBookings(tx),
  );
  tenantRepository<IRentalInspections>(
    TYPES.RentalInspectionRepository,
    (tx) => new PostgresRentalInspections(tx),
  );
  tenantRepository<IVehicleDamages>(
    TYPES.VehicleDamageRepository,
    (tx) => new PostgresVehicleDamages(tx),
  );
  tenantRepository<IRentalReporting>(
    TYPES.RentalReporting,
    (tx) => new PostgresRentalReporting(tx),
  );
  // --- Maintenance: service plans and the due engine (docs/12 §2) ---
  tenantRepository<IServicePlans>(
    TYPES.ServicePlanRepository,
    (tx) => new PostgresServicePlans(tx),
  );
  container.bind<ServiceSchedule>(TYPES.ServiceSchedule).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      plans: IServicePlans,
      vehicleAccess: VehicleAccess,
      settings: INotificationSettingsStore,
      organisation: IOrganisationSettings,
      notifier: Notifier,
      calendar: TenantCalendar,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new ServiceSchedule({
        unitOfWork,
        plans,
        vehicleAccess,
        settings,
        organisation,
        notifier,
        calendar,
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.ServicePlanRepository,
      TYPES.VehicleAccess,
      TYPES.NotificationSettingsStore,
      TYPES.OrganisationSettings,
      TYPES.Notifier,
      TYPES.TenantCalendar,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container
    .bind<ServicePlans>(TYPES.ServicePlans)
    .toResolvedValue(
      (
        unitOfWork: IUnitOfWork,
        plans: IServicePlans,
        schedule: ServiceSchedule,
        auditTrail: IAuditTrail,
        requestContext: IRequestContext,
        ids: IIdGenerator,
        clock: IClock,
      ) =>
        new ServicePlans({ unitOfWork, plans, schedule, auditTrail, requestContext, ids, clock }),
      [
        TYPES.UnitOfWork,
        TYPES.ServicePlanRepository,
        TYPES.ServiceSchedule,
        TYPES.AuditTrail,
        TYPES.RequestContext,
        TYPES.IdGenerator,
        TYPES.Clock,
      ],
    );
  // --- Maintenance: parts inventory (docs/12 §4) ---
  tenantRepository<IParts>(TYPES.PartRepository, (tx) => new PostgresParts(tx));
  container.bind<PartsInventory>(TYPES.PartsInventory).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      parts: IParts,
      vehicles: IVehicleRepository,
      vehicleAccess: VehicleAccess,
      expenses: Expenses,
      expenseSettings: IExpenseSettingsStore,
      reference: ITenantReferenceData,
      posting: LedgerPosting,
      organisation: IOrganisationSettings,
      settings: INotificationSettingsStore,
      notifier: Notifier,
      calendar: TenantCalendar,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new PartsInventory({
        unitOfWork,
        parts,
        vehicles,
        vehicleAccess,
        expenses,
        expenseSettings,
        reference,
        posting,
        organisation,
        settings,
        notifier,
        calendar,
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.PartRepository,
      TYPES.VehicleRepository,
      TYPES.VehicleAccess,
      TYPES.Expenses,
      TYPES.ExpenseSettingsStore,
      TYPES.TenantReferenceData,
      TYPES.LedgerPosting,
      TYPES.OrganisationSettings,
      TYPES.NotificationSettingsStore,
      TYPES.Notifier,
      TYPES.TenantCalendar,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  // --- Incidents, insurance claims, traffic offences and fuel anomalies (docs/06 §7–8) ---
  tenantRepository<IIncidents>(TYPES.VehicleIncidentRepository, (tx) => new PostgresIncidents(tx));
  container.bind<Incidents>(TYPES.Incidents).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      incidents: IIncidents,
      vehicles: IVehicleRepository,
      vehicleAccess: VehicleAccess,
      registry: VehicleRegistry,
      issues: VehicleIssues,
      damages: VehicleDamages,
      posting: LedgerPosting,
      numbering: DocumentNumbering,
      organisation: IOrganisationSettings,
      settings: INotificationSettingsStore,
      notifier: Notifier,
      calendar: TenantCalendar,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new Incidents({
        unitOfWork,
        incidents,
        vehicles,
        vehicleAccess,
        registry,
        issues,
        damages,
        posting,
        numbering,
        organisation,
        settings,
        notifier,
        calendar,
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.VehicleIncidentRepository,
      TYPES.VehicleRepository,
      TYPES.VehicleAccess,
      TYPES.VehicleRegistry,
      TYPES.VehicleIssues,
      TYPES.VehicleDamages,
      TYPES.LedgerPosting,
      TYPES.DocumentNumbering,
      TYPES.OrganisationSettings,
      TYPES.NotificationSettingsStore,
      TYPES.Notifier,
      TYPES.TenantCalendar,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<TrafficOffences>(TYPES.TrafficOffences).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      incidents: IIncidents,
      vehicleAccess: VehicleAccess,
      expenses: Expenses,
      reference: ITenantReferenceData,
      organisation: IOrganisationSettings,
      settings: INotificationSettingsStore,
      notifier: Notifier,
      calendar: TenantCalendar,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new TrafficOffences({
        unitOfWork,
        incidents,
        vehicleAccess,
        expenses,
        reference,
        organisation,
        settings,
        notifier,
        calendar,
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.VehicleIncidentRepository,
      TYPES.VehicleAccess,
      TYPES.Expenses,
      TYPES.TenantReferenceData,
      TYPES.OrganisationSettings,
      TYPES.NotificationSettingsStore,
      TYPES.Notifier,
      TYPES.TenantCalendar,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<FuelAnomalies>(TYPES.FuelAnomalies).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      incidents: IIncidents,
      logs: IFuelLogs,
      vehicleAccess: VehicleAccess,
      settings: INotificationSettingsStore,
      notifier: Notifier,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new FuelAnomalies({
        unitOfWork,
        incidents,
        logs,
        vehicleAccess,
        settings,
        notifier,
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.VehicleIncidentRepository,
      TYPES.FuelLogStore,
      TYPES.VehicleAccess,
      TYPES.NotificationSettingsStore,
      TYPES.Notifier,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  // --- Maintenance KPIs, compliance and the daily maintenance alerts (docs/12 §6, docs/15 §2) ---
  tenantRepository<IMaintenanceReporting>(
    TYPES.MaintenanceReporting,
    (tx) => new PostgresMaintenanceReporting(tx),
  );
  tenantRepository<IPayables>(TYPES.Payables, (tx) => new PostgresPayables(tx));
  tenantRepository<IPurchases>(TYPES.PurchaseRepository, (tx) => new PostgresPurchases(tx));
  container.bind<Purchases>(TYPES.Purchases).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      purchases: IPurchases,
      stock: IDealerStock,
      expenses: Expenses,
      registry: VehicleRegistry,
      vehicles: IVehicleRepository,
      reference: ITenantReferenceData,
      currencies: CurrencySettingsService,
      organisation: IOrganisationSettings,
      posting: LedgerPosting,
      scope: BranchScope,
      numbering: DocumentNumbering,
      files: FileService,
      calendar: TenantCalendar,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new Purchases({
        unitOfWork,
        purchases,
        stock,
        expenses,
        registry,
        vehicles,
        reference,
        currencies,
        organisation,
        posting,
        scope,
        numbering,
        documents: new OwnedDocuments(files, "purchase_document", "purchase", 30),
        calendar,
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.PurchaseRepository,
      TYPES.DealerStockRepository,
      TYPES.Expenses,
      TYPES.VehicleRegistry,
      TYPES.VehicleRepository,
      TYPES.TenantReferenceData,
      TYPES.CurrencySettingsService,
      TYPES.OrganisationSettings,
      TYPES.LedgerPosting,
      TYPES.BranchScope,
      TYPES.DocumentNumbering,
      TYPES.TenantFileService,
      TYPES.TenantCalendar,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container
    .bind<PurchaseAlerts>(TYPES.PurchaseAlerts)
    .toResolvedValue(
      (
        unitOfWork: IUnitOfWork,
        purchases: IPurchases,
        settings: INotificationSettingsStore,
        notifier: Notifier,
      ) => new PurchaseAlerts({ unitOfWork, purchases, settings, notifier }),
      [TYPES.UnitOfWork, TYPES.PurchaseRepository, TYPES.NotificationSettingsStore, TYPES.Notifier],
    );
  // --- Dealer stock (docs/10 §2) ---
  tenantRepository<IDealerStock>(TYPES.DealerStockRepository, (tx) => new PostgresDealerStock(tx));
  container.bind<DealerStock>(TYPES.DealerStock).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      stock: IDealerStock,
      vehicles: IVehicleRepository,
      registry: VehicleRegistry,
      organisation: IOrganisationSettings,
      scope: BranchScope,
      calendar: TenantCalendar,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new DealerStock({
        unitOfWork,
        stock,
        vehicles,
        registry,
        organisation,
        scope,
        calendar,
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.DealerStockRepository,
      TYPES.VehicleRepository,
      TYPES.VehicleRegistry,
      TYPES.OrganisationSettings,
      TYPES.BranchScope,
      TYPES.TenantCalendar,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container
    .bind<StockAlerts>(TYPES.StockAlerts)
    .toResolvedValue(
      (
        unitOfWork: IUnitOfWork,
        stock: IDealerStock,
        settings: INotificationSettingsStore,
        notifier: Notifier,
      ) => new StockAlerts({ unitOfWork, stock, settings, notifier }),
      [
        TYPES.UnitOfWork,
        TYPES.DealerStockRepository,
        TYPES.NotificationSettingsStore,
        TYPES.Notifier,
      ],
    );
  container.bind<SupplierPayables>(TYPES.SupplierPayables).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      payables: IPayables,
      expenses: IExpenseRepository,
      ledger: ILedger,
      parties: IPartyDirectory,
      posting: LedgerPosting,
      payments: PaymentRecording,
      policy: AuthorizationPolicy,
      calendar: TenantCalendar,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      clock: IClock,
    ) =>
      new SupplierPayables({
        unitOfWork,
        payables,
        expenses,
        ledger,
        parties,
        posting,
        payments,
        policy,
        calendar,
        auditTrail,
        requestContext,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.Payables,
      TYPES.ExpenseRepository,
      TYPES.Ledger,
      TYPES.PartyDirectory,
      TYPES.LedgerPosting,
      TYPES.PaymentRecording,
      TYPES.AuthorizationPolicy,
      TYPES.TenantCalendar,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.Clock,
    ],
  );
  container.bind<MaintenanceReports>(TYPES.MaintenanceReports).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      reporting: IMaintenanceReporting,
      stats: VehicleStatsBuilder,
      organisation: IOrganisationSettings,
      posting: LedgerPosting,
      calendar: TenantCalendar,
      scope: BranchScope,
      clock: IClock,
    ) =>
      new MaintenanceReports({
        unitOfWork,
        reporting,
        stats,
        organisation,
        posting,
        calendar,
        scope,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.MaintenanceReporting,
      TYPES.VehicleStatsBuilder,
      TYPES.OrganisationSettings,
      TYPES.LedgerPosting,
      TYPES.TenantCalendar,
      TYPES.BranchScope,
      TYPES.Clock,
    ],
  );
  container
    .bind<MaintenanceAlerts>(TYPES.MaintenanceAlerts)
    .toResolvedValue(
      (
        unitOfWork: IUnitOfWork,
        reporting: IMaintenanceReporting,
        settings: INotificationSettingsStore,
        organisation: IOrganisationSettings,
        notifier: Notifier,
        clock: IClock,
      ) =>
        new MaintenanceAlerts({ unitOfWork, reporting, settings, organisation, notifier, clock }),
      [
        TYPES.UnitOfWork,
        TYPES.MaintenanceReporting,
        TYPES.NotificationSettingsStore,
        TYPES.OrganisationSettings,
        TYPES.Notifier,
        TYPES.Clock,
      ],
    );
  // --- Maintenance: work orders, vendors and downtime (docs/12 §3, §5) ---
  tenantRepository<IWorkOrders>(TYPES.WorkOrderRepository, (tx) => new PostgresWorkOrders(tx));
  container.bind<WorkOrders>(TYPES.WorkOrders).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      orders: IWorkOrders,
      vehicles: IVehicleRepository,
      vehicleAccess: VehicleAccess,
      registry: VehicleRegistry,
      odometer: OdometerLog,
      availability: RentalAvailability,
      schedule: ServiceSchedule,
      plans: IServicePlans,
      issues: VehicleIssues,
      damages: VehicleDamages,
      expenses: Expenses,
      expenseSettings: IExpenseSettingsStore,
      reference: ITenantReferenceData,
      numbering: DocumentNumbering,
      organisation: IOrganisationSettings,
      calendar: TenantCalendar,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
      workpay: WorkPayLifecycle,
      parts: PartsInventory,
    ) =>
      new WorkOrders({
        unitOfWork,
        orders,
        vehicles,
        vehicleAccess,
        registry,
        odometer,
        availability,
        schedule,
        plans,
        issues,
        damages,
        expenses,
        expenseSettings,
        reference,
        numbering,
        organisation,
        calendar,
        auditTrail,
        requestContext,
        ids,
        clock,
        workpay,
        parts,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.WorkOrderRepository,
      TYPES.VehicleRepository,
      TYPES.VehicleAccess,
      TYPES.VehicleRegistry,
      TYPES.OdometerLog,
      TYPES.RentalAvailability,
      TYPES.ServiceSchedule,
      TYPES.ServicePlanRepository,
      TYPES.VehicleIssues,
      TYPES.VehicleDamages,
      TYPES.Expenses,
      TYPES.ExpenseSettingsStore,
      TYPES.TenantReferenceData,
      TYPES.DocumentNumbering,
      TYPES.OrganisationSettings,
      TYPES.TenantCalendar,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
      TYPES.WorkPayLifecycle,
      TYPES.PartsInventory,
    ],
  );
  container.bind<RentalRateAdministration>(TYPES.RentalRateAdministration).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      rates: IRentalRates,
      vehicles: IVehicleRepository,
      vehicleAccess: VehicleAccess,
      branches: IBranches,
      parties: IPartyDirectory,
      reference: ITenantReferenceData,
      organisation: IOrganisationSettings,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
    ) =>
      new RentalRateAdministration({
        unitOfWork,
        rates,
        vehicles,
        vehicleAccess,
        branches,
        parties,
        reference,
        organisation,
        auditTrail,
        requestContext,
        ids,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.RentalRates,
      TYPES.VehicleRepository,
      TYPES.VehicleAccess,
      TYPES.Branches,
      TYPES.PartyDirectory,
      TYPES.TenantReferenceData,
      TYPES.OrganisationSettings,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
    ],
  );
  container.bind<RentalQuotes>(TYPES.RentalQuotes).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      rates: IRentalRates,
      vehicleAccess: VehicleAccess,
      parties: IPartyDirectory,
      reference: ITenantReferenceData,
      organisation: IOrganisationSettings,
      policy: AuthorizationPolicy,
      clock: IClock,
    ) =>
      new RentalQuotes({
        unitOfWork,
        rates,
        vehicleAccess,
        parties,
        reference,
        organisation,
        policy,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.RentalRates,
      TYPES.VehicleAccess,
      TYPES.PartyDirectory,
      TYPES.TenantReferenceData,
      TYPES.OrganisationSettings,
      TYPES.AuthorizationPolicy,
      TYPES.Clock,
    ],
  );
  container.bind<RentalAvailability>(TYPES.RentalAvailability).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      blocks: IVehicleBlocks,
      rates: IRentalRates,
      vehicleAccess: VehicleAccess,
      parties: IPartyDirectory,
      organisation: IOrganisationSettings,
      quotes: RentalQuotes,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new RentalAvailability({
        unitOfWork,
        blocks,
        rates,
        vehicleAccess,
        parties,
        organisation,
        quotes,
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.VehicleBlocks,
      TYPES.RentalRates,
      TYPES.VehicleAccess,
      TYPES.PartyDirectory,
      TYPES.OrganisationSettings,
      TYPES.RentalQuotes,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<RentalInspections>(TYPES.RentalInspections).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      bookings: IRentalBookings,
      inspections: IRentalInspections,
      damages: IVehicleDamages,
      rates: IRentalRates,
      quotes: RentalQuotes,
      files: FileService,
      vehicleAccess: VehicleAccess,
      policy: AuthorizationPolicy,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new RentalInspections({
        unitOfWork,
        bookings,
        inspections,
        damages,
        rates,
        quotes,
        files,
        photos: new OwnedDocuments(files, "rental_photo", BOOKING_PHOTO_OWNER, 60),
        vehicleAccess,
        policy,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.RentalBookingRepository,
      TYPES.RentalInspectionRepository,
      TYPES.VehicleDamageRepository,
      TYPES.RentalRates,
      TYPES.RentalQuotes,
      TYPES.TenantFileService,
      TYPES.VehicleAccess,
      TYPES.AuthorizationPolicy,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<VehicleDamages>(TYPES.VehicleDamages).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      damages: IVehicleDamages,
      bookings: IRentalBookings,
      vehicleAccess: VehicleAccess,
      organisation: IOrganisationSettings,
      files: FileService,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new VehicleDamages({
        unitOfWork,
        damages,
        bookings,
        vehicleAccess,
        organisation,
        files,
        photos: new OwnedDocuments(files, "rental_photo", "vehicle_damage", 10),
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.VehicleDamageRepository,
      TYPES.RentalBookingRepository,
      TYPES.VehicleAccess,
      TYPES.OrganisationSettings,
      TYPES.TenantFileService,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<RentalNotifications>(TYPES.RentalNotifications).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      settings: INotificationSettingsStore,
      organisation: IOrganisationSettings,
      rates: IRentalRates,
      reporting: IRentalReporting,
      notifier: Notifier,
      clock: IClock,
      logger: ILogger,
    ) =>
      new RentalNotifications({
        unitOfWork,
        settings,
        organisation,
        rates,
        reporting,
        notifier,
        clock,
        logger,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.NotificationSettingsStore,
      TYPES.OrganisationSettings,
      TYPES.RentalRates,
      TYPES.RentalReporting,
      TYPES.Notifier,
      TYPES.Clock,
      TYPES.Logger,
    ],
  );
  container.bind<RentalAccounts>(TYPES.RentalAccounts).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      bookings: IRentalBookings,
      invoicing: Invoicing,
      invoices: IInvoiceRepository,
      payments: PaymentRecording,
      posting: LedgerPosting,
      organisation: IOrganisationSettings,
      calendar: TenantCalendar,
      vehicleAccess: VehicleAccess,
      policy: AuthorizationPolicy,
      rates: IRentalRates,
      notifications: RentalNotifications,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new RentalAccounts({
        unitOfWork,
        bookings,
        invoicing,
        invoices,
        payments,
        posting,
        organisation,
        calendar,
        vehicleAccess,
        policy,
        classDeposit: async (classId) =>
          classId === null ? null : ((await rates.vehicleClass(classId))?.depositMinor ?? null),
        notifications,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.RentalBookingRepository,
      TYPES.Invoicing,
      TYPES.InvoiceRepository,
      TYPES.PaymentRecording,
      TYPES.LedgerPosting,
      TYPES.OrganisationSettings,
      TYPES.TenantCalendar,
      TYPES.VehicleAccess,
      TYPES.AuthorizationPolicy,
      TYPES.RentalRates,
      TYPES.RentalNotifications,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<RentalAgreements>(TYPES.RentalAgreements).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      bookings: IRentalBookings,
      inspections: IRentalInspections,
      damages: IVehicleDamages,
      vehicles: IVehicleRepository,
      branches: IBranches,
      documents: Documents,
      issued: IDocumentRepository,
      signers: IDocumentSigners,
      organisation: IOrganisationSettings,
      vehicleAccess: VehicleAccess,
      policy: AuthorizationPolicy,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new RentalAgreements({
        unitOfWork,
        bookings,
        inspections,
        damages,
        vehicles,
        branches,
        documents,
        issued,
        signers,
        organisation,
        vehicleAccess,
        policy,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.RentalBookingRepository,
      TYPES.RentalInspectionRepository,
      TYPES.VehicleDamageRepository,
      TYPES.VehicleRepository,
      TYPES.Branches,
      TYPES.Documents,
      TYPES.DocumentRepository,
      TYPES.DocumentSigners,
      TYPES.OrganisationSettings,
      TYPES.VehicleAccess,
      TYPES.AuthorizationPolicy,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<RentalBookings>(TYPES.RentalBookings).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      bookings: IRentalBookings,
      blocks: IVehicleBlocks,
      rates: IRentalRates,
      availability: RentalAvailability,
      quotes: RentalQuotes,
      inspections: RentalInspections,
      accounts: RentalAccounts,
      agreements: RentalAgreements,
      notifications: RentalNotifications,
      serviceDue: ServiceSchedule,
      vehicleAccess: VehicleAccess,
      registry: VehicleRegistry,
      odometer: OdometerLog,
      numbering: DocumentNumbering,
      organisation: IOrganisationSettings,
      policy: AuthorizationPolicy,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new RentalBookings({
        unitOfWork,
        bookings,
        blocks,
        rates,
        availability,
        quotes,
        inspections,
        accounts,
        agreements,
        notifications,
        serviceDue,
        vehicleAccess,
        registry,
        odometer,
        numbering,
        organisation,
        policy,
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.RentalBookingRepository,
      TYPES.VehicleBlocks,
      TYPES.RentalRates,
      TYPES.RentalAvailability,
      TYPES.RentalQuotes,
      TYPES.RentalInspections,
      TYPES.RentalAccounts,
      TYPES.RentalAgreements,
      TYPES.RentalNotifications,
      TYPES.ServiceSchedule,
      TYPES.VehicleAccess,
      TYPES.VehicleRegistry,
      TYPES.OdometerLog,
      TYPES.DocumentNumbering,
      TYPES.OrganisationSettings,
      TYPES.AuthorizationPolicy,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container
    .bind<RentalReports>(TYPES.RentalReports)
    .toResolvedValue(
      (
        unitOfWork: IUnitOfWork,
        reporting: IRentalReporting,
        organisation: IOrganisationSettings,
        posting: LedgerPosting,
        calendar: TenantCalendar,
        scope: BranchScope,
        clock: IClock,
      ) =>
        new RentalReports({ unitOfWork, reporting, organisation, posting, calendar, scope, clock }),
      [
        TYPES.UnitOfWork,
        TYPES.RentalReporting,
        TYPES.OrganisationSettings,
        TYPES.LedgerPosting,
        TYPES.TenantCalendar,
        TYPES.BranchScope,
        TYPES.Clock,
      ],
    );
  container.bind<WorkPayReports>(TYPES.WorkPayReports).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      reporting: IWorkPayReporting,
      collections: WorkPayCollections,
      drivers: PostgresDriverRepository,
      vehicles: IVehicleRepository,
      printed: PrintedDocuments,
      posting: LedgerPosting,
      scope: BranchScope,
      calendar: TenantCalendar,
    ) =>
      new WorkPayReports({
        unitOfWork,
        reporting,
        collections,
        drivers,
        vehicles,
        printed,
        posting,
        scope,
        calendar,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.WorkPayReporting,
      TYPES.WorkPayCollections,
      TYPES.DriverRepository,
      TYPES.VehicleRepository,
      TYPES.PrintedDocuments,
      TYPES.LedgerPosting,
      TYPES.BranchScope,
      TYPES.TenantCalendar,
    ],
  );
  container.bind<WorkPayTransfers>(TYPES.WorkPayTransfers).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      agreements: IWorkPayAgreementRepository,
      schedule: IWorkPaySchedule,
      transfers: IWorkPayTransfers,
      settings: IWorkPaySettingsStore,
      documents: Documents,
      documentRecords: IDocumentRepository,
      signers: IDocumentSigners,
      vehicles: IVehicleRepository,
      drivers: PostgresDriverRepository,
      assignments: VehicleAssignments,
      files: FileService,
      posting: LedgerPosting,
      scope: BranchScope,
      calendar: TenantCalendar,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
      notifications: WorkPayNotifications,
    ) =>
      new WorkPayTransfers({
        unitOfWork,
        agreements,
        schedule,
        transfers,
        settings,
        documents,
        documentRecords,
        signers,
        vehicles,
        drivers,
        assignments,
        papers: new OwnedDocuments(files, "workpay_transfer_paper", "workpay_transfer", 10),
        posting,
        scope,
        calendar,
        auditTrail,
        requestContext,
        ids,
        clock,
        notifications,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.WorkPayAgreementRepository,
      TYPES.WorkPaySchedule,
      TYPES.WorkPayTransferStore,
      TYPES.WorkPaySettingsStore,
      TYPES.Documents,
      TYPES.DocumentRepository,
      TYPES.DocumentSigners,
      TYPES.VehicleRepository,
      TYPES.DriverRepository,
      TYPES.VehicleAssignments,
      TYPES.TenantFileService,
      TYPES.LedgerPosting,
      TYPES.BranchScope,
      TYPES.TenantCalendar,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
      TYPES.WorkPayNotifications,
    ],
  );
  tenantRepository<IWorkPayAgreementRepository>(
    TYPES.WorkPayAgreementRepository,
    (tx) => new PostgresWorkPayAgreements(tx),
  );
  tenantRepository<IWorkPaySchedule>(
    TYPES.WorkPaySchedule,
    (tx) => new PostgresWorkPaySchedule(tx),
  );
  tenantRepository<IWorkPaySettingsStore>(
    TYPES.WorkPaySettingsStore,
    (tx) => new PostgresWorkPaySettingsStore(tx),
  );
  container.bind<WorkPayAgreements>(TYPES.WorkPayAgreements).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      agreements: IWorkPayAgreementRepository,
      schedule: IWorkPaySchedule,
      settings: IWorkPaySettingsStore,
      documents: Documents,
      transfers: IWorkPayTransfers,
      documentRecords: IDocumentRepository,
      payments: PaymentRecording,
      assignments: VehicleAssignments,
      vehicles: VehicleAccess,
      drivers: DriverAdministration,
      posting: LedgerPosting,
      scope: BranchScope,
      numbering: DocumentNumbering,
      calendar: TenantCalendar,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      ids: IIdGenerator,
      clock: IClock,
    ) =>
      new WorkPayAgreements({
        unitOfWork,
        agreements,
        schedule,
        settings,
        transfers,
        documents,
        documentRecords,
        payments,
        assignments,
        vehicles,
        drivers,
        posting,
        scope,
        numbering,
        calendar,
        auditTrail,
        requestContext,
        ids,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.WorkPayAgreementRepository,
      TYPES.WorkPaySchedule,
      TYPES.WorkPaySettingsStore,
      TYPES.Documents,
      TYPES.WorkPayTransferStore,
      TYPES.DocumentRepository,
      TYPES.PaymentRecording,
      TYPES.VehicleAssignments,
      TYPES.VehicleAccess,
      TYPES.DriverAdministration,
      TYPES.LedgerPosting,
      TYPES.BranchScope,
      TYPES.DocumentNumbering,
      TYPES.TenantCalendar,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.IdGenerator,
      TYPES.Clock,
    ],
  );
  container.bind<WorkPayCollections>(TYPES.WorkPayCollections).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      agreements: IWorkPayAgreementRepository,
      schedule: IWorkPaySchedule,
      settings: IWorkPaySettingsStore,
      payments: PaymentRecording,
      posting: LedgerPosting,
      scope: BranchScope,
      calendar: TenantCalendar,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      clock: IClock,
      lifecycle: IWorkPayLifecycleRecords,
      completion: WorkPayTransfers,
      notifications: WorkPayNotifications,
    ) =>
      new WorkPayCollections({
        unitOfWork,
        agreements,
        schedule,
        lifecycle,
        completion,
        notifications,
        settings,
        payments,
        posting,
        scope,
        calendar,
        auditTrail,
        requestContext,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.WorkPayAgreementRepository,
      TYPES.WorkPaySchedule,
      TYPES.WorkPaySettingsStore,
      TYPES.PaymentRecording,
      TYPES.LedgerPosting,
      TYPES.BranchScope,
      TYPES.TenantCalendar,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.Clock,
      TYPES.WorkPayLifecycleRecords,
      TYPES.WorkPayTransfers,
      TYPES.WorkPayNotifications,
    ],
  );
  tenantRepository<IWorkPayLifecycleRecords>(
    TYPES.WorkPayLifecycleRecords,
    (tx) => new PostgresWorkPayLifecycle(tx),
  );
  container.bind<WorkPayLifecycle>(TYPES.WorkPayLifecycle).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      agreements: IWorkPayAgreementRepository,
      schedule: IWorkPaySchedule,
      records: IWorkPayLifecycleRecords,
      settings: IWorkPaySettingsStore,
      collections: WorkPayCollections,
      assignments: VehicleAssignments,
      vehicles: IVehicleRepository,
      registry: VehicleRegistry,
      posting: LedgerPosting,
      calendar: TenantCalendar,
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      clock: IClock,
    ) =>
      new WorkPayLifecycle({
        unitOfWork,
        agreements,
        schedule,
        records,
        settings,
        collections,
        assignments,
        vehicles,
        registry,
        posting,
        calendar,
        auditTrail,
        requestContext,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.WorkPayAgreementRepository,
      TYPES.WorkPaySchedule,
      TYPES.WorkPayLifecycleRecords,
      TYPES.WorkPaySettingsStore,
      TYPES.WorkPayCollections,
      TYPES.VehicleAssignments,
      TYPES.VehicleRepository,
      TYPES.VehicleRegistry,
      TYPES.LedgerPosting,
      TYPES.TenantCalendar,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.Clock,
    ],
  );
  container
    .bind<WorkPayDriverCosts>(TYPES.WorkPayDriverCosts)
    .toResolvedValue(
      (
        agreements: IWorkPayAgreementRepository,
        schedule: IWorkPaySchedule,
        settings: IWorkPaySettingsStore,
        collections: WorkPayCollections,
        posting: LedgerPosting,
        calendar: TenantCalendar,
      ) =>
        new WorkPayDriverCosts({ agreements, schedule, settings, collections, posting, calendar }),
      [
        TYPES.WorkPayAgreementRepository,
        TYPES.WorkPaySchedule,
        TYPES.WorkPaySettingsStore,
        TYPES.WorkPayCollections,
        TYPES.LedgerPosting,
        TYPES.TenantCalendar,
      ],
    );
  container
    .bind<WorkPayArrears>(TYPES.WorkPayArrears)
    .toResolvedValue(
      (
        unitOfWork: IUnitOfWork,
        agreements: IWorkPayAgreementRepository,
        collections: WorkPayCollections,
        logger: ILogger,
      ) => new WorkPayArrears({ unitOfWork, agreements, collections, logger }),
      [TYPES.UnitOfWork, TYPES.WorkPayAgreementRepository, TYPES.WorkPayCollections, TYPES.Logger],
    );
  container
    .bind<WorkPaySettingsService>(TYPES.WorkPaySettingsService)
    .toResolvedValue(
      (
        unitOfWork: IUnitOfWork,
        settings: IWorkPaySettingsStore,
        auditTrail: IAuditTrail,
        requestContext: IRequestContext,
      ) => new WorkPaySettingsService({ unitOfWork, settings, auditTrail, requestContext }),
      [TYPES.UnitOfWork, TYPES.WorkPaySettingsStore, TYPES.AuditTrail, TYPES.RequestContext],
    );

  // --- Notifications ---
  tenantRepository<INotificationSettingsStore>(
    TYPES.NotificationSettingsStore,
    (tx) => new PostgresNotificationSettingsStore(tx),
  );
  tenantRepository<INotificationInbox>(
    TYPES.NotificationInbox,
    (tx) => new PostgresNotificationInbox(tx),
  );
  container.bind<INotificationDeliveries>(TYPES.NotificationDeliveries).toResolvedValue(
    (tx: PostgresTransactionContext, tenantContext: ITenantContext, queue: IJobQueue) =>
      // After commit, ask the worker to send this tenant's new messages.
      new PostgresNotificationDeliveries(tx, async () => {
        const tenantId = tenantContext.currentTenantId().value;
        await queue.enqueue("notifications.send", { tenantId }, { singletonKey: tenantId });
      }),
    [TYPES.PostgresTransactionContext, TYPES.TenantContext, TYPES.JobQueue],
  );
  tenantRepository<IPushDevices>(TYPES.PushDevices, (tx) => new PostgresPushDevices(tx));
  tenantRepository<IRecipientDirectory>(
    TYPES.RecipientDirectory,
    (tx) => new PostgresRecipientDirectory(tx),
  );
  tenantRepository<INotificationQueries>(
    TYPES.NotificationQueries,
    (tx) => new PostgresNotificationQueries(tx),
  );
  container
    .bind<ISmsGateway[]>(TYPES.SmsGateways)
    .toConstantValue([new HubtelSmsGateway(), new ArkeselSmsGateway(), new MnotifySmsGateway()]);
  container.bind<IPushSender>(TYPES.PushSender).toResolvedValue(
    (logger: ILogger) => {
      if (config.push.provider === "log") return new LoggingPushSender(logger);
      const account = JSON.parse(
        readFileSync(config.push.serviceAccountFile!, "utf8"),
      ) as FcmServiceAccount;
      return new FcmPushSender(account);
    },
    [TYPES.Logger],
  );
  // Tenants' provider credentials: their own key, derived apart from the MFA secrets'.
  container
    .bind<ISecretBox>(TYPES.CredentialsSecretBox)
    .toResolvedValue(
      () =>
        new AesGcmSecretBox(config.auth.mfaEncryptionKey, "autoforce-tenant-provider-credentials"),
    );
  container
    .bind<Notifier>(TYPES.Notifier)
    .toResolvedValue(
      (
        inbox: INotificationInbox,
        deliveries: INotificationDeliveries,
        directory: IRecipientDirectory,
        clock: IClock,
      ) => new Notifier({ inbox, deliveries, directory, clock }),
      [
        TYPES.NotificationInbox,
        TYPES.NotificationDeliveries,
        TYPES.RecipientDirectory,
        TYPES.Clock,
      ],
    );
  container.bind<ReminderRules>(TYPES.ReminderRules).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      settings: INotificationSettingsStore,
      organisation: IOrganisationSettings,
      queries: INotificationQueries,
      notifier: Notifier,
      expenses: ExpenseAdministration,
      posting: LedgerPosting,
      logger: ILogger,
      workpay: WorkPayNotifications,
    ) =>
      new ReminderRules({
        unitOfWork,
        settings,
        organisation,
        queries,
        notifier,
        expenses,
        posting,
        logger,
        workpay,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.NotificationSettingsStore,
      TYPES.OrganisationSettings,
      TYPES.NotificationQueries,
      TYPES.Notifier,
      TYPES.ExpenseAdministration,
      TYPES.LedgerPosting,
      TYPES.Logger,
      TYPES.WorkPayNotifications,
    ],
  );
  container
    .bind<NotificationCenter>(TYPES.NotificationCenter)
    .toResolvedValue(
      (unitOfWork: IUnitOfWork, inbox: INotificationInbox, devices: IPushDevices, clock: IClock) =>
        new NotificationCenter({ unitOfWork, inbox, devices, clock }),
      [TYPES.UnitOfWork, TYPES.NotificationInbox, TYPES.PushDevices, TYPES.Clock],
    );
  container.bind<NotificationSettingsService>(TYPES.NotificationSettingsService).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      settings: INotificationSettingsStore,
      deliveries: INotificationDeliveries,
      secrets: ISecretBox,
      gateways: ISmsGateway[],
      auditTrail: IAuditTrail,
      requestContext: IRequestContext,
      clock: IClock,
    ) =>
      new NotificationSettingsService({
        unitOfWork,
        settings,
        deliveries,
        secrets,
        gateways,
        auditTrail,
        requestContext,
        clock,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.NotificationSettingsStore,
      TYPES.NotificationDeliveries,
      TYPES.CredentialsSecretBox,
      TYPES.SmsGateways,
      TYPES.AuditTrail,
      TYPES.RequestContext,
      TYPES.Clock,
    ],
  );
  container.bind<IJobHandler[]>(TYPES.NotificationJobHandlers).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      deliveries: INotificationDeliveries,
      settings: INotificationSettingsStore,
      organisation: IOrganisationSettings,
      secrets: ISecretBox,
      gateways: ISmsGateway[],
      push: IPushSender,
      devices: IPushDevices,
      emails: IEmailDeliveries,
      queue: IJobQueue,
      roster: ITenantRoster,
      rules: ReminderRules,
      rentals: RentalNotifications,
      clock: IClock,
      logger: ILogger,
    ): IJobHandler[] => [
      new SendNotifications({
        unitOfWork,
        deliveries,
        settings,
        organisation,
        secrets,
        gateways,
        push,
        devices,
        emails,
        queue,
        clock,
        logger,
      }),
      new SweepNotifications({ roster, queue }),
      new RunNotificationRules(rules),
      new RunRemittanceCutoff({ unitOfWork, settings, organisation, rules, queue, clock }),
      new RunRentalReminders(rentals),
      new SweepRentalReminders({ roster, queue }),
    ],
    [
      TYPES.UnitOfWork,
      TYPES.NotificationDeliveries,
      TYPES.NotificationSettingsStore,
      TYPES.OrganisationSettings,
      TYPES.CredentialsSecretBox,
      TYPES.SmsGateways,
      TYPES.PushSender,
      TYPES.PushDevices,
      TYPES.EmailDeliveries,
      TYPES.JobQueue,
      TYPES.TenantRoster,
      TYPES.ReminderRules,
      TYPES.RentalNotifications,
      TYPES.Clock,
      TYPES.Logger,
    ],
  );

  // --- Dashboards and stats ---
  tenantRepository<IVehicleStatsStore>(
    TYPES.VehicleStatsStore,
    (tx) => new PostgresVehicleStatsStore(tx),
  );
  tenantRepository<IDashboardQueries>(
    TYPES.DashboardQueries,
    (tx) => new PostgresDashboardQueries(tx),
  );
  container
    .bind<VehicleStatsBuilder>(TYPES.VehicleStatsBuilder)
    .toResolvedValue(
      (
        unitOfWork: IUnitOfWork,
        stats: IVehicleStatsStore,
        organisation: IOrganisationSettings,
        calendar: TenantCalendar,
        logger: ILogger,
      ) => new VehicleStatsBuilder({ unitOfWork, stats, organisation, calendar, logger }),
      [
        TYPES.UnitOfWork,
        TYPES.VehicleStatsStore,
        TYPES.OrganisationSettings,
        TYPES.TenantCalendar,
        TYPES.Logger,
      ],
    );
  container.bind<Dashboards>(TYPES.Dashboards).toResolvedValue(
    (
      unitOfWork: IUnitOfWork,
      queries: IDashboardQueries,
      stats: VehicleStatsBuilder,
      expenses: ExpenseAdministration,
      vehicles: VehicleAccess,
      posting: LedgerPosting,
      scope: BranchScope,
      calendar: TenantCalendar,
    ) =>
      new Dashboards({
        unitOfWork,
        queries,
        stats,
        expenses,
        vehicles,
        posting,
        scope,
        calendar,
      }),
    [
      TYPES.UnitOfWork,
      TYPES.DashboardQueries,
      TYPES.VehicleStatsBuilder,
      TYPES.ExpenseAdministration,
      TYPES.VehicleAccess,
      TYPES.LedgerPosting,
      TYPES.BranchScope,
      TYPES.TenantCalendar,
    ],
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
      requestContext: IRequestContext,
      support: SupportAccess,
      maintenance: MaintenanceState,
      features: FeatureFlags,
      usage: UsageMeter,
    ) =>
      new AccessGuard({
        authenticate,
        resolveTenant,
        authorization,
        tenantContext,
        staffSessions,
        clock,
        requestContext,
        support,
        maintenance,
        features,
        usage,
      }),
    [
      TYPES.AuthenticateTenantRequest,
      TYPES.ResolveTenant,
      TYPES.AuthorizationPolicy,
      TYPES.TenantContext,
      TYPES.StaffSessions,
      TYPES.Clock,
      TYPES.RequestContext,
      TYPES.SupportAccess,
      TYPES.MaintenanceState,
      TYPES.FeatureFlags,
      TYPES.UsageMeter,
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
      currencySettings: CurrencySettingsService,
      taxAdministration: TaxAdministration,
      fxRateBook: FxRateBook,
      expenseCategories: ExpenseCategoryAdministration,
      vehicleCatalogue: VehicleCatalogue,
      vehicleRegistry: VehicleRegistry,
      vehicleDocuments: VehicleDocuments,
      odometerLog: OdometerLog,
      vehiclePhotos: VehiclePhotos,
      vehicleGroups: VehicleGroupAdministration,
      vehicleImportExport: VehicleImportExport,
      vehicleOverview: VehicleOverview,
      vehicleSettings: VehicleSettingsService,
      driverAdministration: DriverAdministration,
      driverGuarantors: DriverGuarantors,
      customerAdministration: CustomerAdministration,
      supplierAdministration: SupplierAdministration,
      partyDocuments: PartyDocuments,
      driverSettings: DriverSettingsService,
      vehicleAssignments: VehicleAssignments,
      assignmentSettings: AssignmentSettingsService,
      invoicing: Invoicing,
      paymentRecording: PaymentRecording,
      cashSessions: CashSessions,
      ledgerViews: LedgerViews,
      financeSettings: FinanceSettingsService,
      expenses: Expenses,
      fuelLogs: FuelLogs,
      expenseAdministration: ExpenseAdministration,
      recurringExpenses: RecurringExpenses,
      remittanceBook: Remittances,
      driverLedger: DriverLedger,
      operationsBoard: OperationsBoard,
      remittanceSettings: RemittanceSettingsService,
      dashboards: Dashboards,
      notificationCenter: NotificationCenter,
      notificationSettings: NotificationSettingsService,
      driverApp: DriverApp,
      driverAppAccess: DriverAppAccess,
      vehicleIssues: VehicleIssues,
      printedDocuments: PrintedDocuments,
      documents: Documents,
      documentTemplates: DocumentTemplates,
      handoverDocuments: HandoverDocuments,
      documentSigning: DocumentSigning,
      documentSettings: DocumentSettingsService,
      workpayAgreements: WorkPayAgreements,
      workpaySettings: WorkPaySettingsService,
      workpayCollections: WorkPayCollections,
      workpayLifecycle: WorkPayLifecycle,
      workpayTransfers: WorkPayTransfers,
      workpayReports: WorkPayReports,
      gatewayBilling: GatewayBilling,
      reconciliation: GatewayReconciliation,
      paymentGateway: IPaymentGateway,
      billingAutomation: BillingAutomation,
      billingExtensions: BillingExtensions,
      enterpriseQuotes: EnterpriseQuotes,
      branchReconciliation: BranchReconciliation,
      partnerCommissions: PartnerCommissions,
      rentalAdministration: RentalRateAdministration,
      rentalQuotes: RentalQuotes,
      rentalAvailability: RentalAvailability,
      rentalBookings: RentalBookings,
      rentalInspections: RentalInspections,
      vehicleDamages: VehicleDamages,
      rentalAccounts: RentalAccounts,
      rentalAgreements: RentalAgreements,
      rentalReports: RentalReports,
      servicePlans: ServicePlans,
      serviceSchedule: ServiceSchedule,
      workOrders: WorkOrders,
      partsInventory: PartsInventory,
      incidents: Incidents,
      trafficOffences: TrafficOffences,
      fuelAnomalies: FuelAnomalies,
      maintenanceReports: MaintenanceReports,
      supplierPayables: SupplierPayables,
      purchases: Purchases,
      dealerStock: DealerStock,
    ) => {
      const routes = [
        ...healthRoutes(health),
        ...sessionRoutes(),
        ...platformRoutes({ signIn, sessions, administration, approvals, audit }),
        ...applicationRoutes({ signup, review }),
        ...provisioningRoutes({ console: provisioningConsole, acceptInvitation }),
        ...lifecycleRoutes({
          lifecycle,
          branches,
          reconciliation: branchReconciliation,
          publicConfig,
          tenantContext,
          directory,
        }),
        ...consoleRoutes({
          dashboard,
          tenants: tenantAccounts,
          notes,
          dataOperations,
          health: systemHealth,
          auditExport,
        }),
        ...partnerRoutes({ administration: partnerAdministration, portal: partnerPortal }),
        ...partnerCommissionRoutes({ commissions: partnerCommissions }),
        ...legalOperationsRoutes({
          legal: container.get<LegalDocuments>(TYPES.LegalDocuments),
          exports: container.get<TenantDataExports>(TYPES.TenantDataExports),
          requests: container.get<DataProtectionRequests>(TYPES.DataProtectionRequests),
          status: container.get<StatusPage>(TYPES.StatusPage),
          drills: container.get<RestoreDrills>(TYPES.RestoreDrills),
        }),
        ...consoleOperationsRoutes({
          alerts: container.get<PlatformAlerts>(TYPES.PlatformAlerts),
          onCallWebhookConfigured: config.operations.onCallWebhookUrl !== null,
          support: container.get<SupportAccess>(TYPES.SupportAccess),
          users: container.get<TenantUserSupport>(TYPES.TenantUserSupport),
          communications: container.get<Communications>(TYPES.Communications),
          flags: container.get<FeatureFlags>(TYPES.FeatureFlags),
          subscriptions: subscriptionAdministration,
          usage: container.get<TenantUsageHistory>(TYPES.TenantUsageHistory),
          readiness: container.get<LaunchReadiness>(TYPES.LaunchReadiness),
        }),
        ...fileRoutes({ tenantFiles, organisation, applicationDocuments, partnerDocuments }),
        ...mobileRoutes(mobile),
        ...billingRoutes({
          tenantBilling,
          subscriptions: subscriptionAdministration,
          billing: manualBilling,
          gateway: gatewayBilling,
          reconciliation,
          ...(paymentGateway instanceof FakePaymentGateway && !config.isProduction
            ? {
                completeFakePayment: async (reference: string) => {
                  const { body, signature } = paymentGateway.complete(reference);
                  return gatewayBilling.receiveWebhook(
                    Buffer.from(body),
                    signature,
                    JSON.parse(body) as unknown,
                  );
                },
              }
            : {}),
        }),
        ...billingAutomationRoutes({
          automation: billingAutomation,
          extensions: billingExtensions,
        }),
        ...enterpriseQuoteRoutes({ quotes: enterpriseQuotes }),
        ...referenceRoutes({
          currencies: currencySettings,
          tax: taxAdministration,
          fxRates: fxRateBook,
          expenseCategories,
          vehicles: vehicleCatalogue,
        }),
        ...vehicleRoutes({
          registry: vehicleRegistry,
          documents: vehicleDocuments,
          odometer: odometerLog,
          photos: vehiclePhotos,
          groups: vehicleGroups,
          importExport: vehicleImportExport,
          overview: vehicleOverview,
          settings: vehicleSettings,
        }),
        ...partyRoutes({
          drivers: driverAdministration,
          guarantors: driverGuarantors,
          customers: customerAdministration,
          suppliers: supplierAdministration,
          documents: partyDocuments,
          driverSettings,
        }),
        ...assignmentRoutes({ assignments: vehicleAssignments, settings: assignmentSettings }),
        ...financeRoutes({
          invoices: invoicing,
          payments: paymentRecording,
          cashSessions,
          ledger: ledgerViews,
          settings: financeSettings,
        }),
        ...expenseRoutes({
          expenses,
          fuel: fuelLogs,
          administration: expenseAdministration,
          recurring: recurringExpenses,
        }),
        ...remittanceRoutes({
          remittances: remittanceBook,
          ledger: driverLedger,
          board: operationsBoard,
          settings: remittanceSettings,
        }),
        ...dashboardRoutes({ dashboards }),
        ...notificationRoutes({ center: notificationCenter, settings: notificationSettings }),
        ...driverAppRoutes({
          app: driverApp,
          access: driverAppAccess,
          issues: vehicleIssues,
          printed: printedDocuments,
        }),
        ...documentRoutes({
          documents,
          templates: documentTemplates,
          handovers: handoverDocuments,
        }),
        ...signingRoutes({ signing: documentSigning, settings: documentSettings }),
        ...workpayRoutes({
          agreements: workpayAgreements,
          collections: workpayCollections,
          lifecycle: workpayLifecycle,
          transfers: workpayTransfers,
          reports: workpayReports,
          settings: workpaySettings,
        }),
        ...rentalRoutes({
          administration: rentalAdministration,
          quotes: rentalQuotes,
          availability: rentalAvailability,
        }),
        ...rentalBookingRoutes({
          bookings: rentalBookings,
          inspections: rentalInspections,
          agreements: rentalAgreements,
        }),
        ...vehicleDamageRoutes({ damages: vehicleDamages }),
        ...rentalAccountRoutes({ accounts: rentalAccounts }),
        ...rentalReportRoutes({ reports: rentalReports }),
        ...maintenanceRoutes({ plans: servicePlans, schedule: serviceSchedule }),
        ...workOrderRoutes({ orders: workOrders }),
        ...partRoutes({ parts: partsInventory }),
        ...incidentRoutes({ incidents, offences: trafficOffences, anomalies: fuelAnomalies }),
        ...maintenanceReportRoutes({ reports: maintenanceReports }),
        ...payablesRoutes({ payables: supplierPayables }),
        ...purchaseRoutes({ purchases }),
        ...dealerStockRoutes({ stock: dealerStock }),
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
      TYPES.CurrencySettingsService,
      TYPES.TaxAdministration,
      TYPES.FxRateBook,
      TYPES.ExpenseCategoryAdministration,
      TYPES.VehicleCatalogue,
      TYPES.VehicleRegistry,
      TYPES.VehicleDocuments,
      TYPES.OdometerLog,
      TYPES.VehiclePhotos,
      TYPES.VehicleGroupAdministration,
      TYPES.VehicleImportExport,
      TYPES.VehicleOverview,
      TYPES.VehicleSettingsService,
      TYPES.DriverAdministration,
      TYPES.DriverGuarantors,
      TYPES.CustomerAdministration,
      TYPES.SupplierAdministration,
      TYPES.PartyDocuments,
      TYPES.DriverSettingsService,
      TYPES.VehicleAssignments,
      TYPES.AssignmentSettingsService,
      TYPES.Invoicing,
      TYPES.PaymentRecording,
      TYPES.CashSessions,
      TYPES.LedgerViews,
      TYPES.FinanceSettingsService,
      TYPES.Expenses,
      TYPES.FuelLogs,
      TYPES.ExpenseAdministration,
      TYPES.RecurringExpenses,
      TYPES.Remittances,
      TYPES.DriverLedger,
      TYPES.OperationsBoard,
      TYPES.RemittanceSettingsService,
      TYPES.Dashboards,
      TYPES.NotificationCenter,
      TYPES.NotificationSettingsService,
      TYPES.DriverApp,
      TYPES.DriverAppAccess,
      TYPES.VehicleIssues,
      TYPES.PrintedDocuments,
      TYPES.Documents,
      TYPES.DocumentTemplates,
      TYPES.HandoverDocuments,
      TYPES.DocumentSigning,
      TYPES.DocumentSettingsService,
      TYPES.WorkPayAgreements,
      TYPES.WorkPaySettingsService,
      TYPES.WorkPayCollections,
      TYPES.WorkPayLifecycle,
      TYPES.WorkPayTransfers,
      TYPES.WorkPayReports,
      TYPES.GatewayBilling,
      TYPES.GatewayReconciliation,
      TYPES.PaymentGateway,
      TYPES.BillingAutomation,
      TYPES.BillingExtensions,
      TYPES.EnterpriseQuotes,
      TYPES.BranchReconciliation,
      TYPES.PartnerCommissions,
      TYPES.RentalRateAdministration,
      TYPES.RentalQuotes,
      TYPES.RentalAvailability,
      TYPES.RentalBookings,
      TYPES.RentalInspections,
      TYPES.VehicleDamages,
      TYPES.RentalAccounts,
      TYPES.RentalAgreements,
      TYPES.RentalReports,
      TYPES.ServicePlans,
      TYPES.ServiceSchedule,
      TYPES.WorkOrders,
      TYPES.PartsInventory,
      TYPES.Incidents,
      TYPES.TrafficOffences,
      TYPES.FuelAnomalies,
      TYPES.MaintenanceReports,
      TYPES.SupplierPayables,
      TYPES.Purchases,
      TYPES.DealerStock,
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
  // Counters first, while the database is still open (resources are released in no order).
  if (container.isBound(TYPES.UsageMeter)) await container.get<UsageMeter>(TYPES.UsageMeter).stop();
  await container.unbindAllAsync();
}
