import type { Money } from "../../../domain/money/Money.js";
import {
  InvalidTaxCodeError,
  TaxCode,
  type TaxAppliesTo,
  type TaxCodeProps,
  type TaxComponent,
  type TaxLine,
} from "../../../domain/tax/TaxCode.js";
import type { Principal } from "../../authorization/Principal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings, TaxSettings } from "../../ports/IOrganisationSettings.js";
import type { ITenantReferenceData } from "../../ports/IReferenceData.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { recordUserAction } from "./userAudit.js";

export class TaxCodeNotFoundError extends ApplicationError {
  readonly code = "TAX_CODE_NOT_FOUND";
  constructor() {
    super("Tax code not found");
  }
}

export type NewTaxCode = Readonly<{
  code: string;
  name: string;
  kind: TaxCodeProps["kind"];
  appliesTo: readonly TaxAppliesTo[];
}>;

/**
 * The business's tax set-up (docs/13 §6, decision 100): tax registration settings and its own
 * tax codes with dated rates. Rates are never hard-coded: the business (with its accountant)
 * enters them; a code is usable once active. `preview` shows what a document line would carry.
 */
export class TaxAdministration {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      organisation: IOrganisationSettings;
      reference: ITenantReferenceData;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
    }>,
  ) {}

  settings(): Promise<TaxSettings> {
    return this.deps.unitOfWork.run(() => this.deps.organisation.taxSettings());
  }

  async updateSettings(actor: Principal, settings: TaxSettings): Promise<TaxSettings> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (settings.defaultSalesTaxCode !== null) {
        const code = await this.load(settings.defaultSalesTaxCode);
        if (!code.active || !code.snapshot().appliesTo.includes("sales"))
          throw new InvalidTaxCodeError("The default must be an active sales tax code");
      }
      const before = await deps.organisation.taxSettings();
      await deps.organisation.setTaxSettings(settings);
      await recordUserAction(deps, actor.userId, {
        action: "settings.tax_updated",
        entityType: "organisation",
        before,
        after: settings,
      });
      return settings;
    });
  }

  codes(): Promise<TaxCodeProps[]> {
    return this.deps.unitOfWork.run(() => this.deps.reference.taxCodes());
  }

  async code(code: string): Promise<TaxCodeProps> {
    return (await this.deps.unitOfWork.run(() => this.load(code))).snapshot();
  }

  async create(actor: Principal, input: NewTaxCode): Promise<TaxCodeProps> {
    const code = TaxCode.create({
      code: input.code.trim().toUpperCase(),
      name: input.name.trim(),
      kind: input.kind,
      appliesTo: input.appliesTo,
      components: [],
      active: false,
    });
    return this.save(actor, "tax_code.created", code, async () => {
      if ((await this.deps.reference.taxCode(code.code)) !== null)
        throw new InvalidTaxCodeError(`Tax code ${code.code} already exists`);
      return null;
    });
  }

  async rename(
    actor: Principal,
    code: string,
    changes: Readonly<{ name: string; appliesTo: readonly TaxAppliesTo[] }>,
  ): Promise<TaxCodeProps> {
    return this.change(actor, code, "tax_code.updated", (c) =>
      c.rename(changes.name, changes.appliesTo),
    );
  }

  /** A new rate period for a component, e.g. VAT 15 % from 2026-01-01. */
  async addRate(
    actor: Principal,
    code: string,
    component: Omit<TaxComponent, "id">,
  ): Promise<TaxCodeProps> {
    return this.change(actor, code, "tax_code.rate_added", (c) =>
      c.withComponent({ ...component, id: this.deps.ids.next() }),
    );
  }

  async endRate(
    actor: Principal,
    code: string,
    componentId: string,
    effectiveTo: string,
  ): Promise<TaxCodeProps> {
    return this.change(actor, code, "tax_code.rate_ended", (c) =>
      c.endComponent(componentId, effectiveTo),
    );
  }

  async setActive(actor: Principal, code: string, active: boolean): Promise<TaxCodeProps> {
    return this.change(actor, code, active ? "tax_code.activated" : "tax_code.deactivated", (c) =>
      active ? c.activate() : c.deactivate(),
    );
  }

  /** The tax a document line would carry (rates in force on `date`). */
  async preview(code: string, amount: Money, date: string, inclusive?: boolean): Promise<TaxLine> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const taxCode = await this.load(code);
      const settings = await deps.organisation.taxSettings();
      return taxCode.apply(amount, date, inclusive ?? settings.pricesIncludeTax);
    });
  }

  private async load(code: string): Promise<TaxCode> {
    const props = await this.deps.reference.taxCode(code);
    if (props === null) throw new TaxCodeNotFoundError();
    return TaxCode.create(props);
  }

  private change(
    actor: Principal,
    code: string,
    action: string,
    apply: (code: TaxCode) => TaxCode,
  ): Promise<TaxCodeProps> {
    return this.deps.unitOfWork.run(async () => {
      const before = await this.load(code);
      return this.save(actor, action, apply(before), () => Promise.resolve(before.snapshot()));
    });
  }

  private save(
    actor: Principal,
    action: string,
    code: TaxCode,
    loadBefore: () => Promise<TaxCodeProps | null>,
  ): Promise<TaxCodeProps> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await loadBefore();
      await deps.reference.saveTaxCode(code.snapshot());
      await recordUserAction(deps, actor.userId, {
        action,
        entityType: "tax_code",
        entityId: code.code,
        before,
        after: code.snapshot(),
      });
      return code.snapshot();
    });
  }
}
