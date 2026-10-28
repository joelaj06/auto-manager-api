import { FinanceRuleError } from "../../../domain/finance/Journal.js";
import { parseDecimal } from "../../../domain/money/Decimal.js";
import type { LedgerPartyType } from "../../../domain/finance/Journal.js";
import type { Principal } from "../../authorization/Principal.js";
import { FxRateOverrideError, FxRateRequiredError } from "../../errors/FinanceErrors.js";
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
   * manual rate on or before `date` (docs/20 §4). A user (`actor`) who sends a rate other than
   * the one suggested needs `finance.fx_rates.override`; with no rate entered for the date anyone
   * types one (decision 412). Modules pass no actor.
   */
  async rate(
    currency: string,
    date: string,
    fxRate: string | null | undefined,
    actor: Principal | null = null,
  ): Promise<Readonly<{ currency: string; fxRate: string; base: string }>> {
    const { deps } = this;
    const { baseCurrency } = await deps.currencies.get();
    if (currency === baseCurrency) return { currency, fxRate: "1", base: baseCurrency };
    await deps.currencies.assertEnabled(currency);
    const latest = await deps.reference.latestFxRate(baseCurrency, currency, date);
    if (fxRate !== undefined && fxRate !== null) {
      const sent = parseDecimal(fxRate);
      if (sent.units <= 0n) throw new FinanceRuleError("An exchange rate is positive");
      if (
        actor !== null &&
        latest !== null &&
        !sameRate(sent, parseDecimal(latest.rate)) &&
        actor.grantFor("finance.fx_rates.override") === undefined
      )
        throw new FxRateOverrideError(currency, latest.rate);
      return { currency, fxRate, base: baseCurrency };
    }
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

/** The same rate however it is written (`15.4` and `15.40`). */
function sameRate(
  a: Readonly<{ units: bigint; scale: number }>,
  b: Readonly<{ units: bigint; scale: number }>,
): boolean {
  const scale = Math.max(a.scale, b.scale);
  return a.units * 10n ** BigInt(scale - a.scale) === b.units * 10n ** BigInt(scale - b.scale);
}
