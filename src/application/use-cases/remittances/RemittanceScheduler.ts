import { Postings } from "../../../domain/finance/Postings.js";
import { Remittance, targetPeriods } from "../../../domain/remittances/Remittance.js";
import type { IRemittanceRepository } from "../../../domain/repositories/IRemittanceRepository.js";
import type { ITenantDailyTask } from "../../jobs/ITenantDailyTask.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type {
  IRemittanceRecords,
  IRemittanceSettingsStore,
} from "../../ports/IRemittanceRecords.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { localDateTime } from "../../services/TenantLocalTime.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { Remittances } from "./Remittances.js";

/**
 * The expected-remittance job (docs/09 §2): every day, for each fixed-target assignment, creates
 * the rows of the periods that began (snapshotting the target), then posts the target of every
 * period that is over (plus the grace days) as owed by the driver and refreshes statuses —
 * a missed day shows on the driver's ledger the next morning.
 */
export class RemittanceScheduler implements ITenantDailyTask {
  readonly name = "remittances";

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      remittances: IRemittanceRepository;
      records: IRemittanceRecords;
      settings: IRemittanceSettingsStore;
      organisation: IOrganisationSettings;
      book: Remittances;
      posting: LedgerPosting;
      ids: IIdGenerator;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  async run(localDate: string): Promise<void> {
    const { deps } = this;
    const counts = await deps.unitOfWork.run(async () => {
      const { timezone } = await deps.organisation.get();
      const local = (d: Date) => localDateTime(d, timezone).date;
      const now = deps.clock.now();
      let created = 0;
      for (const a of await deps.records.targetAssignments()) {
        const start = local(a.startedAt);
        // The assignment's last day is the day before it ended (ended mid-day: that day counts).
        const end = a.endedAt === null ? null : local(a.endedAt);
        const from = a.lastPeriodStart === null ? start : nextDay(a.lastPeriodStart);
        for (const period of targetPeriods(a, start, end, from, localDate)) {
          await deps.remittances.save(
            Remittance.expected({
              id: deps.ids.next(),
              assignmentId: a.id,
              driverId: a.driverId,
              vehicleId: a.vehicleId,
              branchId: a.branchId,
              periodStart: period.start,
              periodEnd: period.end,
              expectedMinor: a.targetMinor,
              now,
            }),
          );
          created += 1;
        }
      }

      const { graceDays } = await deps.settings.get();
      const accounts = await deps.posting.accounts();
      let accrued = 0;
      for (const id of await deps.records.lockUnsettled()) {
        const remittance = (await deps.remittances.lockById(id))!;
        if (remittance.isDue(localDate, graceDays)) {
          const amount = remittance.accrueTarget(now);
          if (amount > 0) {
            await deps.posting.post(
              Postings.remittanceAccrued(remittance, amount, accounts, localDate),
              null,
            );
            accrued += 1;
          }
        }
        await deps.book.refresh(remittance);
      }
      return { created, accrued };
    });
    if (counts.created + counts.accrued > 0)
      deps.logger.info("Remittances scheduled", { ...counts, localDate });
  }
}

const nextDay = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
