import { FinanceRuleError } from "../../../domain/finance/Journal.js";
import { parseDecimal } from "../../../domain/money/Decimal.js";
import type { LedgerPartyType } from "../../../domain/finance/Journal.js";
import { FxRateRequiredError } from "../../errors/FinanceErrors.js";
import type { IPartyDirectory } from "../../ports/IFinanceRecords.js";
import type { ITenantReferenceData } from "../../ports/IReferenceData.js";
import type { CurrencySettingsService } from "../reference/CurrencySettingsService.js";

/**
 * Shared checks of financial documents (call inside a tenant unit of work): the document
 * currency and its exchange rate on the document date, and who the document is for.
 */
export class FinanceContext {
  constructor(
    private readonly deps: Readonly<{
      currencies: CurrencySettingsService;
      reference: ITenantReferenceData;
      parties: IPartyDirectory;
    }>,
  ) {}

  /**
   * The rate to the base currency ("1" for the base currency): the one sent, else the latest
   * manual rate on or before `date` (docs/20 §4).
   */
  async rate(
    currency: string,
    date: string,
    fxRate: string | null | undefined,
  ): Promise<Readonly<{ currency: string; fxRate: string; base: string }>> {
    const { deps } = this;
    const { baseCurrency } = await deps.currencies.get();
    if (currency === baseCurrency) return { currency, fxRate: "1", base: baseCurrency };
    await deps.currencies.assertEnabled(currency);
    if (fxRate !== undefined && fxRate !== null) {
      if (parseDecimal(fxRate).units <= 0n)
        throw new FinanceRuleError("An exchange rate is positive");
      return { currency, fxRate, base: baseCurrency };
    }
    const latest = await deps.reference.latestFxRate(baseCurrency, currency, date);
    if (latest === null) throw new FxRateRequiredError(currency, date);
    return { currency, fxRate: latest.rate, base: baseCurrency };
  }

  /** The party's name (for the document) and branch (drivers); refuses unknown parties. */
  async party(
    type: LedgerPartyType,
    id: string,
  ): Promise<Readonly<{ name: string; branchId: string | null }>> {
    const party = await this.deps.parties.find(type, id);
    if (party === null) throw new FinanceRuleError(`That ${type} does not exist`);
    return party;
  }
}
