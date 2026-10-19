import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import { OFF_FLEET_STATUSES, VEHICLE_STATUSES } from "../../../domain/vehicles/VehicleStatus.js";
import {
  checkReminderDays,
  DEFAULT_REMINDER_DAYS,
  evaluateCompliance,
  type ComplianceLevel,
  type ComplianceStatus,
  type VehicleDocumentType,
} from "../../../domain/vehicles/VehicleCompliance.js";
import { InvalidVehicleError } from "../../../domain/vehicles/VehicleIdentifiers.js";
import type { Principal } from "../../authorization/Principal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type {
  IVehicleDocuments,
  IVehicleQueries,
  IVehicleSettingsStore,
  VehicleComplianceSettings,
  VehicleDocument,
} from "../../ports/IVehicleRecords.js";
import { localDateTime } from "../../services/TenantLocalTime.js";
import type { FileView, UploadStarted } from "../files/FileService.js";
import type { DocumentUploadInput, OwnedDocuments } from "../files/OwnedDocuments.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { VehicleAccess } from "./VehicleAccess.js";

export class VehicleDocumentNotFoundError extends ApplicationError {
  readonly code = "VEHICLE_DOCUMENT_NOT_FOUND";
  constructor() {
    super("Vehicle document not found");
  }
}

export type VehicleDocumentInput = Readonly<{
  type: VehicleDocumentType;
  title?: string | null;
  number?: string | null;
  provider?: string | null;
  issuedOn?: string | null;
  expiresOn?: string | null;
  /** What the renewal cost, in the base currency (decimal string). */
  cost?: string | null;
  reminderDays?: readonly number[];
  notes?: string | null;
}>;

export type VehicleDocumentView = Omit<VehicleDocument, "costMinor"> &
  Readonly<{ cost: MoneyJson | null; files: readonly FileView[] }>;

export type ComplianceBoardRow = Readonly<{
  vehicleId: string;
  code: string;
  plateNumber: string | null;
  make: string;
  model: string;
  branchId: string;
  status: string;
}> &
  ComplianceStatus;

export type ComplianceBoard = Readonly<{
  date: string;
  summary: Readonly<Record<ComplianceLevel, number>>;
  /** Vehicles that cannot legally operate today (red), then amber, then green. */
  vehicles: readonly ComplianceBoardRow[];
}>;

/** Result of a compliance check by another module (rental check-out, driver assignment …). */
export type OperabilityCheck = ComplianceStatus &
  Readonly<{ enforcement: VehicleComplianceSettings["enforcement"] }>;

const MAX_BOARD = 5_000;
const ORDER: Readonly<Record<ComplianceLevel, number>> = { red: 0, amber: 1, green: 2 };

/**
 * Vehicle documents and compliance (docs/06 §4): registration, roadworthy, insurance, tax
 * sticker, permits … with expiry dates and scans. A renewal is a new document (the old one is
 * history). Per vehicle red / amber / green, and the board of vehicles that cannot legally
 * operate today.
 */
export class VehicleDocuments {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      documents: IVehicleDocuments;
      queries: IVehicleQueries;
      settings: IVehicleSettingsStore;
      organisation: IOrganisationSettings;
      access: VehicleAccess;
      files: OwnedDocuments;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  async list(
    actor: Principal,
    vehicleId: string,
  ): Promise<Readonly<{ compliance: ComplianceStatus; documents: VehicleDocumentView[] }>> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      await deps.access.reach(actor, vehicleId, "vehicles.documents.view");
      const documents = await deps.documents.list(vehicleId);
      const [rules, today, currency] = await this.context();
      return {
        compliance: evaluateCompliance(documents, rules, today),
        documents: await this.views(documents, currency),
      };
    });
  }

  async add(
    actor: Principal,
    vehicleId: string,
    input: VehicleDocumentInput,
  ): Promise<VehicleDocumentView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      await deps.access.reach(actor, vehicleId, "vehicles.documents.manage");
      const settings = await deps.settings.get();
      const now = deps.clock.now();
      const document = this.checked({
        id: deps.ids.next(),
        vehicleId,
        type: input.type,
        title: input.title ?? null,
        number: input.number ?? null,
        provider: input.provider ?? null,
        issuedOn: input.issuedOn ?? null,
        expiresOn: input.expiresOn ?? null,
        costMinor: await this.minor(input.cost ?? null),
        reminderDays:
          input.reminderDays ??
          settings.reminderDays[input.type] ??
          DEFAULT_REMINDER_DAYS[input.type],
        notes: input.notes ?? null,
        createdBy: actor.userId,
        createdAt: now,
        updatedAt: now,
      });
      await deps.documents.save(document);
      await recordUserAction(deps, actor.userId, {
        action: "vehicle_document.added",
        entityType: "vehicle",
        entityId: vehicleId,
        after: document,
      });
      return this.view(document, (await deps.organisation.currencySettings()).baseCurrency);
    });
  }

  async update(
    actor: Principal,
    vehicleId: string,
    documentId: string,
    changes: Omit<Partial<VehicleDocumentInput>, "type">,
  ): Promise<VehicleDocumentView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await this.reach(actor, vehicleId, documentId, "vehicles.documents.manage");
      const after = this.checked({
        ...before,
        ...Object.fromEntries(
          Object.entries(changes).filter(([k, v]) => v !== undefined && k !== "cost"),
        ),
        costMinor: changes.cost === undefined ? before.costMinor : await this.minor(changes.cost),
        updatedAt: deps.clock.now(),
      });
      await deps.documents.save(after);
      await recordUserAction(deps, actor.userId, {
        action: "vehicle_document.updated",
        entityType: "vehicle",
        entityId: vehicleId,
        before,
        after,
      });
      return this.view(after, (await deps.organisation.currencySettings()).baseCurrency);
    });
  }

  async remove(actor: Principal, vehicleId: string, documentId: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const document = await this.reach(actor, vehicleId, documentId, "vehicles.documents.manage");
      for (const file of await deps.files.list(documentId))
        await deps.files.remove(documentId, file.id);
      await deps.documents.remove(documentId);
      await recordUserAction(deps, actor.userId, {
        action: "vehicle_document.removed",
        entityType: "vehicle",
        entityId: vehicleId,
        before: document,
      });
    });
  }

  async startFileUpload(
    actor: Principal,
    vehicleId: string,
    documentId: string,
    input: DocumentUploadInput,
  ): Promise<UploadStarted> {
    await this.deps.unitOfWork.run(() =>
      this.reach(actor, vehicleId, documentId, "vehicles.documents.manage"),
    );
    return this.deps.files.start(documentId, input, actor.userId);
  }

  async completeFileUpload(
    actor: Principal,
    vehicleId: string,
    documentId: string,
    fileId: string,
  ): Promise<FileView> {
    await this.deps.unitOfWork.run(() =>
      this.reach(actor, vehicleId, documentId, "vehicles.documents.manage"),
    );
    return this.deps.files.complete(documentId, fileId);
  }

  async removeFile(
    actor: Principal,
    vehicleId: string,
    documentId: string,
    fileId: string,
  ): Promise<void> {
    await this.deps.unitOfWork.run(() =>
      this.reach(actor, vehicleId, documentId, "vehicles.documents.manage"),
    );
    await this.deps.files.remove(documentId, fileId);
  }

  /** Compliance of one vehicle (used by the overview). */
  async compliance(vehicleId: string): Promise<ComplianceStatus> {
    const documents = await this.deps.documents.list(vehicleId);
    const [rules, today] = await this.context();
    return evaluateCompliance(documents, rules, today);
  }

  /**
   * For modules about to put a vehicle on the road (rental check-out, assignment): its
   * compliance today and whether the business blocks or only warns (call inside their unit of
   * work).
   */
  async operability(vehicleId: string): Promise<OperabilityCheck> {
    const { compliance } = await this.deps.settings.get();
    return { ...(await this.compliance(vehicleId)), enforcement: compliance.enforcement };
  }

  /** Every vehicle in the caller's branches with its compliance (red first). */
  async board(
    actor: Principal,
    filter: Readonly<{ level?: ComplianceLevel; branchId?: string }>,
  ): Promise<ComplianceBoard> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const vehicles = await deps.queries.list({
        branchIds: deps.access.branchesFor(actor, "vehicles.documents.view"),
        ...(filter.branchId === undefined ? {} : { branchId: filter.branchId }),
        statuses: VEHICLE_STATUSES.filter((s) => !OFF_FLEET_STATUSES.has(s)),
        limit: MAX_BOARD,
      });
      const documents = await deps.documents.forVehicles(vehicles.map((v) => v.id));
      const [rules, today] = await this.context();
      const rows = vehicles
        .map((v): ComplianceBoardRow => ({
          vehicleId: v.id,
          code: v.code,
          plateNumber: v.plateNumber,
          make: v.make,
          model: v.model,
          branchId: v.branchId,
          status: v.status,
          ...evaluateCompliance(
            documents.filter((d) => d.vehicleId === v.id),
            rules,
            today,
          ),
        }))
        .sort((a, b) => ORDER[a.level] - ORDER[b.level] || a.code.localeCompare(b.code));
      const summary = { red: 0, amber: 0, green: 0 };
      for (const row of rows) summary[row.level] += 1;
      return {
        date: today,
        summary,
        vehicles: filter.level === undefined ? rows : rows.filter((r) => r.level === filter.level),
      };
    });
  }

  private async reach(
    actor: Principal,
    vehicleId: string,
    documentId: string,
    permission: "vehicles.documents.manage" | "vehicles.documents.view",
  ): Promise<VehicleDocument> {
    await this.deps.access.reach(actor, vehicleId, permission);
    const document = await this.deps.documents.get(documentId);
    if (document?.vehicleId !== vehicleId) throw new VehicleDocumentNotFoundError();
    return document;
  }

  private async context(): Promise<[VehicleComplianceSettings, string, string]> {
    const { deps } = this;
    const settings = await deps.settings.get();
    const organisation = await deps.organisation.get();
    const currency = await deps.organisation.currencySettings();
    return [
      settings.compliance,
      localDateTime(deps.clock.now(), organisation.timezone).date,
      currency.baseCurrency,
    ];
  }

  private async minor(cost: string | null): Promise<number | null> {
    if (cost === null) return null;
    const { baseCurrency } = await this.deps.organisation.currencySettings();
    const amount = Money.parse(cost, baseCurrency).amountMinor;
    if (amount < 0) throw new InvalidVehicleError("A cost cannot be negative");
    return amount;
  }

  private checked(document: VehicleDocument): VehicleDocument {
    const text = (value: string | null, max: number) => {
      const trimmed = value?.trim() ?? "";
      if (trimmed.length > max) throw new InvalidVehicleError(`Keep it under ${max} characters`);
      return trimmed === "" ? null : trimmed;
    };
    if (
      document.issuedOn !== null &&
      document.expiresOn !== null &&
      document.expiresOn < document.issuedOn
    )
      throw new InvalidVehicleError("A document cannot expire before it was issued");
    return {
      ...document,
      title: text(document.title, 120),
      number: text(document.number, 60),
      provider: text(document.provider, 120),
      notes: text(document.notes, 2_000),
      reminderDays: checkReminderDays(document.reminderDays),
    };
  }

  private async views(
    documents: readonly VehicleDocument[],
    currency: string,
  ): Promise<VehicleDocumentView[]> {
    const views: VehicleDocumentView[] = [];
    for (const document of documents) views.push(await this.view(document, currency));
    return views;
  }

  private async view(document: VehicleDocument, currency: string): Promise<VehicleDocumentView> {
    const { costMinor, ...rest } = document;
    return {
      ...rest,
      cost: costMinor === null ? null : Money.ofMinor(costMinor, currency).toJSON(),
      files: await this.deps.files.list(document.id),
    };
  }
}
