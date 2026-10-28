import { DomainError } from "../../../domain/errors/DomainError.js";
import {
  CURRENCIES,
  CURRENCY_CODES,
  currencyInfo,
  type CurrencyInfo,
} from "../../../domain/money/Currency.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { ICurrencyUsage } from "../../ports/ICurrencyUsage.js";
import type { CurrencySettings, IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { recordUserAction } from "./userAudit.js";

export class CurrencyRuleError extends DomainError {
  constructor(
    readonly code: "CURRENCY_BASE_LOCKED" | "CURRENCY_NOT_ENABLED" | "CURRENCY_IN_USE",
    message: string,
  ) {
    super(message);
  }
}

export type CurrencySettingsChanges = Readonly<{
  baseCurrency?: string;
  enabledCurrencies?: readonly string[];
  display?: Readonly<{ showCodeForForeign: boolean }>;
}>;

/**
 * Currency settings (docs/20 §3, §8): the base currency (GHS by default) — changeable only until
 * the first financial transaction — and the extra currencies users may pick on documents. A
 * currency stays enabled while invoices or expenses in it are still open (decision 413).
 */
export class CurrencySettingsService {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      organisation: IOrganisationSettings;
      usage: ICurrencyUsage;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
    }>,
  ) {}

  /** The catalogue clients use instead of hard-coding currencies. */
  catalogue(): readonly CurrencyInfo[] {
    return CURRENCY_CODES.map((code) => CURRENCIES[code]);
  }

  get(): Promise<CurrencySettings> {
    return this.deps.unitOfWork.run(() => this.deps.organisation.currencySettings());
  }

  async update(actor: Principal, changes: CurrencySettingsChanges): Promise<CurrencySettings> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await deps.organisation.currencySettings();
      const baseCurrency = currencyInfo(changes.baseCurrency ?? before.baseCurrency).code;
      if (baseCurrency !== before.baseCurrency && before.baseCurrencyLockedAt !== null)
        throw new CurrencyRuleError(
          "CURRENCY_BASE_LOCKED",
          "The base currency is fixed once money has been recorded; contact support",
        );
      const enabled = [
        ...new Set([
          baseCurrency,
          ...(changes.enabledCurrencies ?? before.enabledCurrencies).map(
            (code) => currencyInfo(code).code,
          ),
        ]),
      ];
      for (const code of before.enabledCurrencies.filter((c) => !enabled.includes(c))) {
        const open = await deps.usage.openDocuments(code);
        if (open.invoices + open.expenses > 0)
          throw new CurrencyRuleError(
            "CURRENCY_IN_USE",
            `${code} is still on ${open.invoices} open invoice(s) and ${open.expenses} unpaid expense(s); settle or void them first`,
          );
      }
      const next = {
        baseCurrency,
        enabledCurrencies: enabled,
        display: changes.display ?? before.display,
      };
      await deps.organisation.setCurrencySettings(next);
      await recordUserAction(deps, actor.userId, {
        action: "settings.currency_updated",
        entityType: "organisation",
        before,
        after: next,
      });
      return deps.organisation.currencySettings();
    });
  }

  /** Throws unless `currency` may be used on a new document (docs/20 §8). */
  async assertEnabled(currency: string): Promise<void> {
    const settings = await this.get();
    if (!settings.enabledCurrencies.includes(currency))
      throw new CurrencyRuleError(
        "CURRENCY_NOT_ENABLED",
        `${currency} is not enabled for this business (Settings → Currency)`,
      );
  }
}
