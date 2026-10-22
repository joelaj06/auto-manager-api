import type { ExpenseProps } from "../../../domain/expenses/Expense.js";
import { Postings } from "../../../domain/finance/Postings.js";
import type { Responsibility, WorkPayAgreement } from "../../../domain/workpay/WorkPayAgreement.js";
import { outstanding } from "../../../domain/workpay/WorkPayCollections.js";
import type { IExpenseDriverCosts } from "../../ports/IExpenseDriverCosts.js";
import type {
  IWorkPayAgreementRepository,
  IWorkPaySchedule,
  IWorkPaySettingsStore,
} from "../../ports/IWorkPayRecords.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { WorkPayCollections } from "./WorkPayCollections.js";

/** Which of the agreement's responsibilities an expense category falls under. */
const RESPONSIBILITY_OF: Readonly<Record<string, "maintenance" | "insurance">> = {
  maintenance: "maintenance",
  tyres: "maintenance",
  insurance: "insurance",
};

const RUNNING = new Set(["active", "in_arrears", "defaulted"]);

/**
 * Costs a work and pay driver bears (docs/08 §8): maintenance, tyres or insurance on their
 * vehicle are charged to them when the agreement makes them responsible (unless the expense says
 * otherwise). By the business's setting the cost stays on their driver ledger, or is added to
 * the agreement and paid with the instalments — cancelled again if the expense is voided.
 */
export class WorkPayDriverCosts implements IExpenseDriverCosts {
  constructor(
    private readonly deps: Readonly<{
      agreements: IWorkPayAgreementRepository;
      schedule: IWorkPaySchedule;
      settings: IWorkPaySettingsStore;
      collections: WorkPayCollections;
      posting: LedgerPosting;
      calendar: TenantCalendar;
    }>,
  ) {}

  async defaultBearer(
    expense: Readonly<{ categoryCode: string; vehicleIds: readonly string[] }>,
  ): Promise<string | null> {
    const kind = RESPONSIBILITY_OF[expense.categoryCode];
    if (kind === undefined || expense.vehicleIds.length !== 1) return null;
    const agreement = await this.running({ vehicleId: expense.vehicleIds[0]! });
    if (agreement === null) return null;
    const a = agreement.snapshot();
    const responsible: Responsibility = kind === "maintenance" ? a.maintenance : a.insurance;
    return responsible === "driver" ? a.driverId : null;
  }

  async approved(expense: ExpenseProps, chargedMinor: number, userId: string | null) {
    const { deps } = this;
    if (!expense.chargeToDriver || expense.driverId === null || chargedMinor <= 0) return;
    if ((await deps.settings.get()).driverExpenses !== "agreement") return;
    const agreement = await this.running({ driverId: expense.driverId }, true);
    if (agreement === null) return;
    const a = agreement.snapshot();
    const today = await deps.calendar.today();
    const description = `Expense ${expense.number ?? ""}: ${expense.description}`.slice(0, 300);
    const chargeId = await deps.schedule.addCharge({
      agreementId: a.id,
      expenseId: expense.id,
      description,
      chargedOn: today,
      amountMinor: chargedMinor,
    });
    await deps.posting.post(
      Postings.workpayCharge(
        a,
        { chargeId, direction: "added", amountMinor: chargedMinor, description, date: today },
        await deps.posting.accounts(),
      ),
      userId,
    );
  }

  async voided(expense: ExpenseProps, userId: string | null) {
    const { deps } = this;
    const charge = await deps.schedule.chargeForExpense(expense.id);
    if (charge === null) return;
    const left = outstanding(charge);
    if (left === 0) return;
    const agreement = (await deps.agreements.lockById(charge.agreementId))!;
    const today = await deps.calendar.today();
    await deps.schedule.saveCharge({ ...charge, waivedMinor: charge.waivedMinor + left });
    await deps.posting.post(
      Postings.workpayCharge(
        agreement.snapshot(),
        {
          chargeId: charge.id,
          direction: "cancelled",
          amountMinor: left,
          description: charge.description,
          date: today,
        },
        await deps.posting.accounts(),
      ),
      userId,
    );
    await deps.collections.settle(agreement, today);
  }

  private async running(
    party: Readonly<{ vehicleId?: string; driverId?: string }>,
    lock = false,
  ): Promise<WorkPayAgreement | null> {
    const live = await this.deps.agreements.liveFor(party);
    if (live === null || !RUNNING.has(live.status)) return null;
    return lock ? this.deps.agreements.lockById(live.id) : live;
  }
}
