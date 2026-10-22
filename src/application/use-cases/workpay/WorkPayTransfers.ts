import type { IssuedDocumentProps } from "../../../domain/documents/IssuedDocument.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { IDriverRepository } from "../../../domain/repositories/IPartyRepositories.js";
import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import type { WorkPayAgreement } from "../../../domain/workpay/WorkPayAgreement.js";
import { WorkPayRuleError } from "../../../domain/workpay/WorkPayTerms.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IDocumentRepository, IDocumentSigners } from "../../ports/IDocumentRecords.js";
import type { IDocumentSignedListener } from "../../ports/IDocumentSignedListener.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type {
  DvlaStatus,
  HandedOverItem,
  IWorkPayAgreementRepository,
  IWorkPaySchedule,
  IWorkPaySettingsStore,
  IWorkPayTransfers,
  TransferRecord,
} from "../../ports/IWorkPayRecords.js";
import type { BranchScope } from "../../services/BranchScope.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { VehicleAssignments } from "../assignments/VehicleAssignments.js";
import type { Documents } from "../documents/Documents.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { DocumentUploadInput, OwnedDocuments } from "../files/OwnedDocuments.js";
import { recordUserAction } from "../reference/userAudit.js";
import { AgreementNotFoundError } from "./WorkPayAgreements.js";

export type TransferRequest = Readonly<{
  /** Default: the vehicle's last odometer reading. */
  odometer?: number;
  condition?: string | null;
  /** Default: the business's list, all handed over. */
  handedOver?: readonly HandedOverItem[];
  /** Signs for the business (default: who signed the agreement for it). */
  ownerSignerId?: string;
}>;

export type TransferView = Omit<TransferRecord, "documentId"> &
  Readonly<{
    status: "awaiting_signatures" | "transferred";
    document: Readonly<{ id: string; number: string; status: string }>;
    attachments?: readonly Awaited<ReturnType<OwnedDocuments["list"]>>[number][];
  }>;

/**
 * Completion and transfer (docs/08 §5, docs/24 §2): an agreement paid in full gets its transfer
 * letter, issued for the owner and the driver to sign; once both signed, ownership passes — the
 * assignment ends, the vehicle is transferred and driver-owned. Until then corrections replace
 * the letter, and reopening the agreement (a reversed payment) withdraws it; after the
 * transfer nothing reopens it. The DVLA change of ownership is tracked with its papers.
 */
export class WorkPayTransfers implements IDocumentSignedListener {
  readonly documentType = "transfer_letter";

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      agreements: IWorkPayAgreementRepository;
      schedule: IWorkPaySchedule;
      transfers: IWorkPayTransfers;
      settings: IWorkPaySettingsStore;
      documents: Documents;
      documentRecords: IDocumentRepository;
      signers: IDocumentSigners;
      vehicles: IVehicleRepository;
      drivers: IDriverRepository;
      assignments: VehicleAssignments;
      papers: OwnedDocuments;
      posting: LedgerPosting;
      scope: BranchScope;
      calendar: TenantCalendar;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  // --- following the agreement (inside its unit of work) ---

  /** Paid in full: the transfer letter goes out with the defaults. */
  async agreementCompleted(agreement: WorkPayAgreement, userId: string | null): Promise<void> {
    if ((await this.deps.transfers.forAgreement(agreement.id, true)) !== null) return;
    await this.issue(agreement, {}, userId, null);
  }

  /** Not fully paid any more (a payment reversed): the letter is withdrawn. */
  async agreementReopened(agreement: WorkPayAgreement, userId: string | null): Promise<void> {
    const { deps } = this;
    const transfer = await deps.transfers.forAgreement(agreement.id, true);
    if (transfer === null) return;
    if (transfer.transferredAt !== null)
      throw new WorkPayRuleError(
        "The vehicle has been transferred to the driver: the agreement cannot be reopened",
      );
    await deps.documents.voidFor(
      userId ?? transfer.ownerSignerId,
      transfer.documentId,
      "The agreement is no longer fully paid",
    );
    await deps.transfers.remove(agreement.id);
  }

  // --- staff ---

  async get(actor: Principal, id: string): Promise<TransferView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await this.reach(actor, id, "workpay.view");
      const transfer = await deps.transfers.forAgreement(agreement.id);
      if (transfer === null)
        throw new WorkPayRuleError(
          agreement.status === "completed"
            ? "No transfer letter yet: issue it"
            : "The transfer letter comes once the agreement is paid in full",
        );
      return this.view(transfer, true);
    });
  }

  /** Issues the letter again with corrections (odometer, condition, items, signer). */
  async reissue(actor: Principal, id: string, request: TransferRequest): Promise<TransferView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await this.reach(actor, id, "workpay.transfer.manage", true);
      if (agreement.status !== "completed")
        throw new WorkPayRuleError("The transfer letter comes once the agreement is paid in full");
      const current = await deps.transfers.forAgreement(agreement.id, true);
      if (current !== null && current.transferredAt !== null)
        throw new WorkPayRuleError("The letter is signed and the vehicle transferred");
      const transfer = await this.issue(agreement, request, actor.userId, current);
      return this.view(transfer, false);
    });
  }

  /** The DVLA change of ownership, after the transfer. */
  async updateDvla(
    actor: Principal,
    id: string,
    request: Readonly<{
      status: DvlaStatus;
      submittedOn?: string | null;
      completedOn?: string | null;
      reference?: string | null;
      notes?: string | null;
    }>,
  ): Promise<TransferView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await this.reach(actor, id, "workpay.transfer.manage", true);
      const transfer = await this.transferred(agreement.id);
      const today = await deps.calendar.today();
      const submittedOn =
        request.status === "not_started"
          ? null
          : (request.submittedOn ?? transfer.dvla.submittedOn ?? today);
      const completedOn =
        request.status === "completed"
          ? (request.completedOn ?? transfer.dvla.completedOn ?? today)
          : null;
      if (submittedOn !== null && submittedOn > today)
        throw new WorkPayRuleError("The submission date cannot be in the future");
      if (completedOn !== null && (completedOn > today || completedOn < submittedOn!))
        throw new WorkPayRuleError("The DVLA completes after the submission and not in the future");
      const next: TransferRecord = {
        ...transfer,
        dvla: {
          status: request.status,
          submittedOn,
          completedOn,
          reference:
            request.reference === undefined
              ? transfer.dvla.reference
              : request.reference?.trim() || null,
          notes: request.notes === undefined ? transfer.dvla.notes : request.notes?.trim() || null,
        },
      };
      await deps.transfers.save(next);
      await this.audit(actor.userId, "workpay.dvla_updated", agreement, { dvla: next.dvla });
      return this.view(next, true);
    });
  }

  async startPaper(actor: Principal, id: string, input: DocumentUploadInput) {
    const transfer = await this.deps.unitOfWork.run(async () =>
      this.transferred((await this.reach(actor, id, "workpay.transfer.manage")).id),
    );
    return this.deps.papers.start(transfer.id, input, actor.userId);
  }

  async completePaper(actor: Principal, id: string, fileId: string) {
    const transfer = await this.deps.unitOfWork.run(async () =>
      this.transferred((await this.reach(actor, id, "workpay.transfer.manage")).id),
    );
    return this.deps.papers.complete(transfer.id, fileId);
  }

  // --- the driver ---

  /** The driver's copy of their transfer letter (the signed one once both signed). */
  async letterForDriver(driverId: string, id: string) {
    const { deps } = this;
    const transfer = await deps.unitOfWork.run(async () => {
      const agreement = await deps.agreements.findById(id);
      if (agreement === null || agreement.snapshot().driverId !== driverId)
        throw new AgreementNotFoundError();
      const t = await deps.transfers.forAgreement(agreement.id);
      if (t === null) throw new WorkPayRuleError("There is no transfer letter yet");
      return t;
    });
    return deps.documents.downloadForParty(
      transfer.documentId,
      transfer.transferredAt === null ? "issued" : "signed",
      null,
    );
  }

  // --- signing ---

  /** Both parties signed the letter: ownership passes to the driver. */
  async fullySigned(document: IssuedDocumentProps): Promise<void> {
    const { deps } = this;
    const transfer = await deps.transfers.forDocument(document.id, true);
    if (transfer === null || transfer.transferredAt !== null) return;
    const agreement = (await deps.agreements.lockById(transfer.agreementId))!;
    const a = agreement.snapshot();
    const vehicle = (await deps.vehicles.lockById(a.vehicleId))!;
    const driver = (await deps.drivers.findById(a.driverId))!.snapshot();
    const now = deps.clock.now();
    const reason = `Ownership transferred to ${driver.firstName} ${driver.lastName} (work and pay agreement ${a.number})`;
    await deps.assignments.endForTransfer(a.id, vehicle, {
      odometer: transfer.odometer,
      reason,
      userId: transfer.ownerSignerId,
    });
    vehicle.updateDetails(
      { ownershipType: "driver_owned", ownershipNote: reason },
      now,
      now.getUTCFullYear(),
    );
    await deps.vehicles.save(vehicle);
    await deps.transfers.save({ ...transfer, transferredAt: now });
    await deps.auditTrail.record({
      action: "workpay.ownership_transferred",
      entityType: "workpay_agreement",
      entityId: a.id,
      actorType: "system",
      actorId: null,
      requestId: deps.requestContext.current()?.requestId ?? null,
      ip: null,
      before: { vehicleStatus: "on_workpay" },
      after: { vehicleStatus: "transferred", documentId: document.id },
      metadata: { vehicleId: a.vehicleId, driverId: a.driverId },
    });
  }

  // --- helpers ---

  private async issue(
    agreement: WorkPayAgreement,
    request: TransferRequest,
    userId: string | null,
    replaces: TransferRecord | null,
  ): Promise<TransferRecord> {
    const { deps } = this;
    const a = agreement.snapshot();
    const vehicle = (await deps.vehicles.findById(a.vehicleId))!.snapshot();
    const driver = (await deps.drivers.findById(a.driverId))!.snapshot();
    const settings = await deps.settings.get();
    const ownerSignerId =
      request.ownerSignerId ??
      replaces?.ownerSignerId ??
      (await this.agreementOwnerSigner(agreement));
    if (ownerSignerId === null)
      throw new WorkPayRuleError("Say who signs the transfer letter for the business");
    const odometer = request.odometer ?? replaces?.odometer ?? vehicle.currentOdometer ?? 0;
    if (!Number.isInteger(odometer) || odometer < 0)
      throw new WorkPayRuleError("Give the odometer as a whole number");
    const condition =
      request.condition === undefined
        ? (replaces?.condition ?? null)
        : request.condition?.trim() || null;
    const handedOver =
      request.handedOver ??
      replaces?.handedOver ??
      settings.transferItems.map((item) => ({ item, included: true }));
    const instalments = await deps.schedule.list(a.id);
    const m = await this.money();
    const paidMinor = a.depositPaidMinor + instalments.reduce((sum, i) => sum + i.paidMinor, 0);
    const today = await deps.calendar.today();
    const document = await deps.documents.issue(userId ?? ownerSignerId, {
      type: "transfer_letter",
      subject: { type: "workpay_agreement", id: a.id },
      branchId: a.branchId,
      replacesId: replaces?.documentId ?? null,
      data: {
        vehicle: {
          code: vehicle.code,
          plateNumber: vehicle.plateNumber,
          make: vehicle.make,
          model: vehicle.model,
          year: vehicle.year,
          colour: vehicle.colour,
          vin: vehicle.vin ?? vehicle.chassisNumber,
          engineNumber: vehicle.engineNumber,
        },
        driver: {
          code: driver.code,
          name: `${driver.firstName} ${driver.lastName}`,
          phone: driver.phone,
          address: driver.address,
          ghanaCardNumber: driver.ghanaCardNumber,
          licenceNumber: driver.licenceNumber,
        },
        agreement: {
          number: a.number,
          startDate: a.startedOn,
          totalPaid: m(paidMinor),
          finalPaymentOn:
            a.completedAt === null ? today : await deps.calendar.dateOf(a.completedAt),
        },
        transfer: { odometer, unit: vehicle.mileageUnit, condition },
        handedOver,
      },
      signers: [
        { role: "owner", party: { type: "user", id: ownerSignerId } },
        { role: "driver", party: { type: "driver", id: a.driverId } },
      ],
    });
    const transfer: TransferRecord = {
      id: replaces?.id ?? deps.ids.next(),
      agreementId: a.id,
      documentId: document.id,
      odometer,
      condition,
      handedOver,
      ownerSignerId,
      issuedBy: userId,
      issuedAt: deps.clock.now(),
      transferredAt: null,
      dvla: {
        status: "not_started",
        submittedOn: null,
        completedOn: null,
        reference: null,
        notes: null,
      },
    };
    await deps.transfers.save(transfer);
    await this.audit(userId, "workpay.transfer_letter_issued", agreement, {
      documentId: document.id,
      replaces: replaces?.documentId ?? null,
    });
    return transfer;
  }

  /** The user who signed the work and pay agreement for the business. */
  private async agreementOwnerSigner(agreement: WorkPayAgreement): Promise<string | null> {
    const documentId = agreement.snapshot().documentId;
    if (documentId === null) return null;
    const owner = (await this.deps.signers.listFor(documentId))
      .map((s) => s.snapshot())
      .find((s) => s.role === "owner" && s.partyType === "user");
    return owner?.partyId ?? null;
  }

  private async transferred(agreementId: string): Promise<TransferRecord> {
    const transfer = await this.deps.transfers.forAgreement(agreementId, true);
    if (transfer === null || transfer.transferredAt === null)
      throw new WorkPayRuleError("The DVLA change of ownership follows the signed transfer");
    return transfer;
  }

  private async view(transfer: TransferRecord, withPapers: boolean): Promise<TransferView> {
    const { documentId, ...rest } = transfer;
    const document = (await this.deps.documentRecords.findById(documentId))!.snapshot();
    return {
      ...rest,
      status: transfer.transferredAt === null ? "awaiting_signatures" : "transferred",
      document: { id: document.id, number: document.number, status: document.status },
      ...(withPapers ? { attachments: await this.deps.papers.list(transfer.id) } : {}),
    };
  }

  private async reach(
    actor: Principal,
    id: string,
    permission: PermissionKey,
    lock = false,
  ): Promise<WorkPayAgreement> {
    const { deps } = this;
    const agreement = lock
      ? await deps.agreements.lockById(id)
      : await deps.agreements.findById(id);
    if (agreement === null) throw new AgreementNotFoundError();
    await deps.scope.assertReaches(
      actor,
      permission,
      agreement.snapshot().branchId,
      () => new AgreementNotFoundError(),
    );
    return agreement;
  }

  private async money(): Promise<(minor: number) => MoneyJson> {
    const base = await this.deps.posting.baseCurrency();
    return (minor) => Money.ofMinor(minor, base).toJSON();
  }

  private async audit(
    userId: string | null,
    action: string,
    agreement: WorkPayAgreement,
    metadata: Readonly<Record<string, unknown>>,
  ) {
    const a = agreement.snapshot();
    const entry = {
      action,
      entityType: "workpay_agreement",
      entityId: a.id,
      after: { number: a.number, status: a.status },
      metadata,
    };
    if (userId !== null) await recordUserAction(this.deps, userId, entry);
    else
      await this.deps.auditTrail.record({
        ...entry,
        actorType: "system",
        actorId: null,
        requestId: this.deps.requestContext.current()?.requestId ?? null,
        ip: null,
        before: null,
      });
  }
}
