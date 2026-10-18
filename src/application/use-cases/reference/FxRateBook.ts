import { currencyInfo } from "../../../domain/money/Currency.js";
import { InvalidDecimalError, parseDecimal } from "../../../domain/money/Decimal.js";
import type { Principal } from "../../authorization/Principal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { FxRate, ITenantReferenceData } from "../../ports/IReferenceData.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { recordUserAction } from "./userAudit.js";

export class FxRateError extends ApplicationError {
  constructor(
    readonly code: "FX_RATE_EXISTS" | "FX_RATE_NOT_FOUND" | "FX_SAME_CURRENCY",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Manual exchange rates (docs/20 §5.3, V1): the accountant enters the rate of a foreign currency
 * against the base currency per day; forms suggest the latest rate on or before the document
 * date. A provider feed comes later.
 */
export class FxRateBook {
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

  list(filter: Readonly<{ quote?: string; limit: number }>): Promise<FxRate[]> {
    return this.deps.unitOfWork.run(() => this.deps.reference.fxRates(filter));
  }

  /** The rate to suggest on a form, or null (the user then types one). */
  suggest(quote: string, date: string): Promise<FxRate | null> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const { baseCurrency } = await deps.organisation.currencySettings();
      return deps.reference.latestFxRate(baseCurrency, currencyInfo(quote).code, date);
    });
  }

  async add(
    actor: Principal,
    input: Readonly<{ quote: string; rate: string; rateDate: string }>,
  ): Promise<FxRate> {
    const { deps } = this;
    const rate = parseDecimal(input.rate);
    if (rate.units <= 0n || rate.scale > 10)
      throw new InvalidDecimalError("A rate is positive, with at most 10 decimals");
    return deps.unitOfWork.run(async () => {
      const { baseCurrency } = await deps.organisation.currencySettings();
      const quote = currencyInfo(input.quote).code;
      if (quote === baseCurrency)
        throw new FxRateError("FX_SAME_CURRENCY", "The rate is for a foreign currency");
      if (await deps.reference.fxRateExists(baseCurrency, quote, input.rateDate))
        throw new FxRateError(
          "FX_RATE_EXISTS",
          `A ${quote} rate for ${input.rateDate} exists; remove it first`,
        );
      const id = deps.ids.next();
      await deps.reference.addFxRate({
        id,
        base: baseCurrency,
        quote,
        rate: input.rate.trim(),
        rateDate: input.rateDate,
        source: "manual",
        enteredBy: actor.userId,
      });
      await recordUserAction(deps, actor.userId, {
        action: "fx_rate.added",
        entityType: "fx_rate",
        entityId: id,
        after: { base: baseCurrency, quote, rate: input.rate.trim(), rateDate: input.rateDate },
      });
      const stored = await deps.reference.latestFxRate(baseCurrency, quote, input.rateDate);
      return stored!;
    });
  }

  async remove(actor: Principal, id: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      if (!(await deps.reference.removeFxRate(id)))
        throw new FxRateError("FX_RATE_NOT_FOUND", "Exchange rate not found");
      await recordUserAction(deps, actor.userId, {
        action: "fx_rate.removed",
        entityType: "fx_rate",
        entityId: id,
      });
    });
  }
}
