import {
  Appraisal,
  AppraisalRuleError,
  type AppraisalDetails,
  type AppraisalProps,
  type AppraisalStatus,
  type Condition,
} from "../../../domain/dealer/Appraisal.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { Principal } from "../../authorization/Principal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IAppraisals, IDeals } from "../../ports/IDealerDeals.js";
import type { ILeads } from "../../ports/IDealerSales.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import { TenantCalendar } from "../../services/TenantCalendar.js";
import type { DocumentUploadInput, OwnedDocuments } from "../files/OwnedDocuments.js";
import type { FileView, UploadStarted } from "../files/FileService.js";
import type { DocumentNumbering } from "../reference/DocumentNumbering.js";
import { recordUserAction } from "../reference/userAudit.js";
import { LeadNotFoundError, reachesLead } from "./DealerLeads.js";

export class AppraisalNotFoundError extends ApplicationError {
  readonly code = "APPRAISAL_NOT_FOUND";
  constructor() {
    super("Appraisal not found");
  }
}

/** Days an appraisal's value holds when none is given. */
export const DEFAULT_APPRAISAL_DAYS = 14;
const PERMISSION = "dealer.appraisals.manage";
export const APPRAISAL_PHOTO_OWNER = "dealer_appraisal";

export type AppraisalInput = Readonly<{
  make: string;
  model: string;
  year?: number | null;
  plateNumber?: string | null;
  vin?: string | null;
  colour?: string | null;
  mileage?: number | null;
  condition: Condition;
  findings?: string | null;
  value: string;
  validUntil?: string;
}>;

export type AppraisalQuery = Readonly<{
  statuses?: readonly AppraisalStatus[];
  leadId?: string;
  customerId?: string;
  limit: number;
  beforeId?: string;
}>;

export type AppraisalView = Omit<AppraisalProps, "valueMinor"> &
  Readonly<{ value: MoneyJson; photos?: readonly FileView[] }>;

/**
 * Trade-in appraisals (docs/10 §7): the vehicle offered in part exchange recorded with its
 * condition, mileage, findings and photos and valued until a date by the appraiser; a deal takes
 * it as part payment and, at the sale, it enters stock at that value (decisions 445–452).
 */
export class Appraisals {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      appraisals: IAppraisals;
      deals: IDeals;
      leads: ILeads;
      photos: OwnedDocuments;
      organisation: IOrganisationSettings;
      scope: BranchScope;
      numbering: DocumentNumbering;
      calendar: TenantCalendar;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  list(actor: Principal, query: AppraisalQuery): Promise<AppraisalView[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const base = await this.base();
      return (
        await deps.appraisals.list({
          ...query,
          branchIds: deps.scope.branchesFor(actor, PERMISSION),
        })
      ).map((a) => view(a, base));
    });
  }

  get(actor: Principal, id: string): Promise<AppraisalView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const appraisal = await this.reach(actor, id);
      return { ...view(appraisal, await this.base()), photos: await deps.photos.list(id) };
    });
  }

  create(
    actor: Principal,
    input: AppraisalInput &
      Readonly<{ branchId?: string; leadId?: string | null; customerId?: string | null }>,
  ): Promise<AppraisalView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const branchId =
        input.branchId ?? (await deps.scope.defaultBranch(actor, PERMISSION, "appraisal"));
      await deps.scope.branch(actor, PERMISSION, branchId);
      const today = await deps.calendar.today();
      const base = await this.base();
      let customerId = input.customerId ?? null;
      let leadId: string | null = null;
      if (input.leadId !== undefined && input.leadId !== null) {
        const lead = await deps.leads.get(input.leadId);
        if (lead === null || !reachesLead(actor, deps.scope, "dealer.leads.view", lead))
          throw new LeadNotFoundError();
        leadId = lead.id;
        customerId ??= lead.snapshot().customerId;
      }
      if (customerId !== null && (await deps.deals.customer(customerId)) === null)
        throw new AppraisalRuleError("The customer was not found");
      const now = deps.clock.now();
      const appraisal = Appraisal.record({
        ...details(input, base, today),
        id: deps.ids.next(),
        number: await deps.numbering.next("appraisal", now),
        branchId,
        leadId,
        customerId,
        appraisedBy: actor.userId,
        today,
        now,
      });
      await deps.appraisals.insert(appraisal);
      await this.audit(actor, "appraisal.recorded", appraisal);
      return view(appraisal, base);
    });
  }

  revise(actor: Principal, id: string, input: AppraisalInput): Promise<AppraisalView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const appraisal = await this.reach(actor, id, true);
      const base = await this.base();
      const today = await deps.calendar.today();
      appraisal.revise(details(input, base, today), today, deps.clock.now());
      await deps.appraisals.update(appraisal);
      await this.audit(actor, "appraisal.revised", appraisal);
      return view(appraisal, base);
    });
  }

  decline(actor: Principal, id: string, reason: string): Promise<AppraisalView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const appraisal = await this.reach(actor, id, true);
      appraisal.decline(reason, deps.clock.now());
      await deps.appraisals.update(appraisal);
      await this.audit(actor, "appraisal.declined", appraisal);
      return view(appraisal, await this.base());
    });
  }

  startPhoto(actor: Principal, id: string, input: DocumentUploadInput): Promise<UploadStarted> {
    return this.deps.unitOfWork.run(async () => {
      await this.reach(actor, id);
      return this.deps.photos.start(id, input, actor.userId);
    });
  }

  completePhoto(actor: Principal, id: string, fileId: string): Promise<FileView> {
    return this.deps.unitOfWork.run(async () => {
      await this.reach(actor, id);
      return this.deps.photos.complete(id, fileId);
    });
  }

  private async reach(actor: Principal, id: string, lock = false): Promise<Appraisal> {
    const { deps } = this;
    const appraisal = lock ? await deps.appraisals.lock(id) : await deps.appraisals.get(id);
    if (appraisal === null || !deps.scope.can(actor, PERMISSION, appraisal.snapshot().branchId))
      throw new AppraisalNotFoundError();
    return appraisal;
  }

  private async base(): Promise<string> {
    return (await this.deps.organisation.currencySettings()).baseCurrency;
  }

  private async audit(actor: Principal, action: string, appraisal: Appraisal): Promise<void> {
    const a = appraisal.snapshot();
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: APPRAISAL_PHOTO_OWNER,
      entityId: appraisal.id,
      after: { number: a.number, status: a.status, valueMinor: a.valueMinor, make: a.make },
    });
  }
}

function details(input: AppraisalInput, base: string, today: string): AppraisalDetails {
  return {
    make: input.make,
    model: input.model,
    year: input.year ?? null,
    plateNumber: input.plateNumber ?? null,
    vin: input.vin ?? null,
    colour: input.colour ?? null,
    mileage: input.mileage ?? null,
    condition: input.condition,
    findings: input.findings ?? null,
    valueMinor: Money.parse(input.value, base).amountMinor,
    validUntil: input.validUntil ?? TenantCalendar.addDays(today, DEFAULT_APPRAISAL_DAYS),
  };
}

export function view(appraisal: Appraisal, base: string): AppraisalView {
  const { valueMinor, ...rest } = appraisal.snapshot();
  return { ...rest, value: Money.ofMinor(valueMinor, base).toJSON() };
}
