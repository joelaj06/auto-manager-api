import {
  reversal,
  type JournalDraft,
  type SystemAccountKey,
} from "../../../domain/finance/Journal.js";
import type { AccountResolver } from "../../../domain/finance/Postings.js";
import { PeriodLockedError } from "../../errors/FinanceErrors.js";
import type { IClock } from "../../ports/IClock.js";
import type { ILedger } from "../../ports/IFinanceRecords.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { DocumentNumbering } from "../reference/DocumentNumbering.js";

/**
 * Posts journal entries (call inside the unit of work of the document): numbers them (JRN),
 * refuses dates in a locked period, and fixes the base currency at the first posting. Every
 * correction is a reversal of the source's entries, never an edit.
 */
export class LedgerPosting {
  constructor(
    private readonly deps: Readonly<{
      ledger: ILedger;
      numbering: DocumentNumbering;
      organisation: IOrganisationSettings;
      clock: IClock;
    }>,
  ) {}

  async accounts(): Promise<AccountResolver> {
    const byKey = new Map<string, string>();
    for (const account of await this.deps.ledger.accounts())
      if (account.systemKey !== null) byKey.set(account.systemKey, account.id);
    return (key: SystemAccountKey) => {
      const id = byKey.get(key);
      if (id === undefined) throw new Error(`System account ${key} is missing`);
      return id;
    };
  }

  async baseCurrency(): Promise<string> {
    return (await this.deps.organisation.currencySettings()).baseCurrency;
  }

  async assertOpen(date: string): Promise<void> {
    const locked = await this.deps.ledger.booksLockedUntil();
    if (locked !== null && date <= locked) throw new PeriodLockedError(locked);
  }

  async post(entry: JournalDraft, userId: string | null): Promise<string> {
    const { deps } = this;
    await this.assertOpen(entry.date);
    const number = await deps.numbering.next("journal", new Date(`${entry.date}T12:00:00Z`));
    const id = await deps.ledger.post(entry, number, userId);
    await deps.ledger.lockBaseCurrency(deps.clock.now());
    return id;
  }

  /** Cancels every open entry of a source with a reversal dated `date`. */
  async reverse(
    source: Readonly<{ type: string; id: string }>,
    date: string,
    description: string,
    userId: string | null,
  ): Promise<void> {
    for (const entry of await this.deps.ledger.openEntries(source.type, source.id))
      await this.post(reversal(entry, date, description), userId);
  }
}
