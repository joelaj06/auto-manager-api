import type { IClock } from "../ports/IClock.js";
import type { IOrganisationSettings } from "../ports/IOrganisationSettings.js";
import { localDateTime } from "./TenantLocalTime.js";

/** Today in the tenant's timezone (call inside a tenant unit of work). */
export class TenantCalendar {
  constructor(
    private readonly deps: Readonly<{ organisation: IOrganisationSettings; clock: IClock }>,
  ) {}

  async today(): Promise<string> {
    const { timezone } = await this.deps.organisation.get();
    return localDateTime(this.deps.clock.now(), timezone).date;
  }

  /** The tenant's local date of an instant. */
  async dateOf(instant: Date): Promise<string> {
    const { timezone } = await this.deps.organisation.get();
    return localDateTime(instant, timezone).date;
  }

  /** `days` after a YYYY-MM-DD date. */
  static addDays(date: string, days: number): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
}
