import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { IDriverRepository } from "../../../domain/repositories/IPartyRepositories.js";
import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import type { WorkPayAgreement } from "../../../domain/workpay/WorkPayAgreement.js";
import {
  collectionRate,
  daysInArrears,
  forecast,
  portfolioAtRisk,
  portfolioSummary,
} from "../../../domain/workpay/WorkPayPortfolio.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { AgeingBucket, IWorkPayReporting } from "../../ports/IWorkPayReporting.js";
import type { BranchScope } from "../../services/BranchScope.js";
import { TenantCalendar } from "../../services/TenantCalendar.js";
import type { PdfFile, PrintedDocuments } from "../documents/PrintedDocuments.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { BalanceView, WorkPayCollections } from "./WorkPayCollections.js";

export type WorkPayStatement = Readonly<{
  asOf: string;
  agreement: Readonly<{
    id: string;
    number: string;
    status: string;
    startedOn: string | null;
    completedAt: Date | null;
    frequency: string;
  }>;
  driver: Readonly<{ id: string; code: string; name: string; phone: string }>;
  vehicle: Readonly<{
    id: string;
    code: string;
    plateNumber: string | null;
    make: string;
    model: string;
  }>;
  terms: Readonly<{ totalPrice: MoneyJson; deposit: MoneyJson; financed: MoneyJson }>;
  totals: Readonly<{
    /** Deposit and instalments paid. */
    paidToDate: MoneyJson;
    instalmentsPaid: MoneyJson;
    outstanding: MoneyJson;
    overdue: MoneyJson;
    penaltiesOutstanding: MoneyJson;
    chargesOutstanding: MoneyJson;
    /** Instalments paid over what they come to (one decimal). */
    percentComplete: number;
    daysInArrears: number;
    nextDue: BalanceView["nextDue"];
  }>;
  schedule: readonly Readonly<{
    number: number;
    dueOn: string;
    amount: MoneyJson;
    paid: MoneyJson;
    waived: MoneyJson;
    rescheduled: MoneyJson;
    status: string;
  }>[];
  payments: readonly Readonly<{
    paymentId: string;
    number: string;
    kind: "deposit" | "instalments";
    paidOn: string;
    method: string;
    amount: MoneyJson;
    reversed: boolean;
  }>[];
  penalties: BalanceView["penalties"];
  charges: BalanceView["charges"];
}>;

export type PortfolioView = Readonly<{
  asOf: string;
  agreements: Readonly<{ running: number; byStatus: Readonly<Record<string, number>> }>;
  financed: MoneyJson;
  collected: MoneyJson;
  outstanding: MoneyJson;
  overdue: MoneyJson;
  penaltiesOutstanding: MoneyJson;
  chargesOutstanding: MoneyJson;
  completionPercent: number | null;
  /** Portfolio at risk: outstanding of agreements more than N days in arrears. */
  par: readonly Readonly<{
    days: number;
    agreements: number;
    outstanding: MoneyJson;
    percent: number | null;
  }>[];
  /** Overdue instalments by how long they have been overdue. */
  ageing: Readonly<Record<AgeingBucket, MoneyJson>>;
  /** Instalments due in the last 30 days: paid over due. */
  collectionRate: Readonly<{
    from: string;
    to: string;
    due: MoneyJson;
    paid: MoneyJson;
    percent: number | null;
  }>;
  forecast: Readonly<{
    next7: MoneyJson;
    next30: MoneyJson;
    next90: MoneyJson;
    weeks: readonly Readonly<{ from: string; to: string; amount: MoneyJson }>[];
  }>;
}>;

export type ArrearsRow = Readonly<{
  agreementId: string;
  number: string;
  status: string;
  driver: Readonly<{ id: string; name: string; phone: string }>;
  vehicle: Readonly<{ id: string; code: string; plateNumber: string | null }>;
  overdue: MoneyJson;
  penaltiesOutstanding: MoneyJson;
  outstanding: MoneyJson;
  arrearsSince: string;
  daysInArrears: number;
  nextDueOn: string | null;
}>;

/**
 * Work & Pay reporting (docs/08 §6–7, docs/14): the agreement statement (for staff and the
 * driver, as JSON and PDF), the portfolio dashboard — financed, collected, outstanding, PAR
 * 7/30/60/90, ageing, collection rate and the collections forecast — and the arrears list.
 */
export class WorkPayReports {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      reporting: IWorkPayReporting;
      collections: WorkPayCollections;
      drivers: IDriverRepository;
      vehicles: IVehicleRepository;
      printed: PrintedDocuments;
      posting: LedgerPosting;
      scope: BranchScope;
      calendar: TenantCalendar;
    }>,
  ) {}

  async statement(actor: Principal, id: string): Promise<WorkPayStatement> {
    return this.deps.unitOfWork.run(async () =>
      this.statementOf(await this.deps.collections.reach(actor, id, "workpay.view")),
    );
  }

  /** A driver's statement of their own agreement (driver app). */
  async statementOfOwn(driverId: string, id: string): Promise<WorkPayStatement> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await deps.collections.reachOwn(driverId, id);
      return this.statementOf(agreement);
    });
  }

  async statementPdf(actor: Principal, id: string): Promise<PdfFile> {
    return this.deps.printed.workpayStatement(await this.statement(actor, id));
  }

  async statementPdfOfOwn(driverId: string, id: string): Promise<PdfFile> {
    return this.deps.printed.workpayStatement(await this.statementOfOwn(driverId, id));
  }

  async portfolio(
    actor: Principal,
    query: Readonly<{ branchId?: string }>,
  ): Promise<PortfolioView> {
    return this.within(actor, "dashboards.workpay.view", query, async ({ filter, today, m }) => {
      const { reporting } = this.deps;
      const rows = await reporting.portfolio(filter, today);
      const summary = portfolioSummary(rows);
      const ageing = await reporting.ageing(filter, today);
      const from = TenantCalendar.addDays(today, -29);
      const window = await reporting.collected(filter, from, today);
      const ahead = forecast(
        await reporting.dueBetween(
          filter,
          TenantCalendar.addDays(today, 1),
          TenantCalendar.addDays(today, 91),
        ),
        today,
      );
      return {
        asOf: today,
        agreements: { running: summary.running, byStatus: summary.byStatus },
        financed: m(summary.financedMinor),
        collected: m(summary.collectedMinor),
        outstanding: m(summary.outstandingMinor),
        overdue: m(summary.overdueMinor),
        penaltiesOutstanding: m(summary.penaltiesOutstandingMinor),
        chargesOutstanding: m(summary.chargesOutstandingMinor),
        completionPercent: summary.completionPercent,
        par: portfolioAtRisk(rows, today).map((b) => ({
          days: b.days,
          agreements: b.agreements,
          outstanding: m(b.outstandingMinor),
          percent: b.percent,
        })),
        ageing: {
          "1-7": m(ageing["1-7"]),
          "8-30": m(ageing["8-30"]),
          "31-60": m(ageing["31-60"]),
          "61-90": m(ageing["61-90"]),
          over_90: m(ageing.over_90),
        },
        collectionRate: {
          from,
          to: today,
          due: m(window.dueMinor),
          paid: m(window.paidMinor),
          percent: collectionRate(window.dueMinor, window.paidMinor),
        },
        forecast: {
          next7: m(ahead.next7Minor),
          next30: m(ahead.next30Minor),
          next90: m(ahead.next90Minor),
          weeks: ahead.weeks.map((w) => ({ from: w.from, to: w.to, amount: m(w.amountMinor) })),
        },
      };
    });
  }

  /** Agreements in arrears, longest first. */
  async arrears(
    actor: Principal,
    query: Readonly<{ branchId?: string; limit: number }>,
  ): Promise<ArrearsRow[]> {
    return this.within(actor, "dashboards.workpay.view", query, async ({ filter, today, m }) => {
      const rows = (await this.deps.reporting.portfolio(filter, today)).filter(
        (r) => r.arrearsSince !== null && r.status !== "completed",
      );
      return rows
        .map((r) => ({
          agreementId: r.agreementId,
          number: r.number,
          status: r.status,
          driver: { id: r.driverId, name: r.driverName, phone: r.phone },
          vehicle: { id: r.vehicleId, code: r.vehicleCode, plateNumber: r.plateNumber },
          overdue: m(r.overdueMinor),
          penaltiesOutstanding: m(r.penaltiesOutstandingMinor),
          outstanding: m(r.outstandingMinor),
          arrearsSince: r.arrearsSince!,
          daysInArrears: daysInArrears(r.arrearsSince, today),
          nextDueOn: r.nextDueOn,
        }))
        .sort(
          (x, y) =>
            y.daysInArrears - x.daysInArrears || y.overdue.amountMinor - x.overdue.amountMinor,
        )
        .slice(0, query.limit);
    });
  }

  // --- helpers ---

  private async statementOf(agreement: WorkPayAgreement): Promise<WorkPayStatement> {
    const { deps } = this;
    const a = agreement.snapshot();
    const today = await deps.calendar.today();
    const m = await this.money();
    const driver = (await deps.drivers.findById(a.driverId))!.snapshot();
    const vehicle = (await deps.vehicles.findById(a.vehicleId))!.snapshot();
    const ledger = await deps.collections.ledger(a.id);
    const balance = await deps.collections.balanceOf(agreement, today);
    const value = ledger.instalments.reduce(
      (sum, i) => sum + i.amountMinor - i.rescheduledMinor,
      0,
    );
    const waived = ledger.instalments.reduce((sum, i) => sum + i.waivedMinor, 0);
    const paid = ledger.instalments.reduce((sum, i) => sum + i.paidMinor, 0);
    const owedInAll = value - waived;
    return {
      asOf: today,
      agreement: {
        id: a.id,
        number: a.number,
        status: a.status,
        startedOn: a.startedOn,
        completedAt: a.completedAt,
        frequency: agreement.scheduleBasis.frequency,
      },
      driver: {
        id: driver.id,
        code: driver.code,
        name: `${driver.firstName} ${driver.lastName}`,
        phone: driver.phone,
      },
      vehicle: {
        id: vehicle.id,
        code: vehicle.code,
        plateNumber: vehicle.plateNumber,
        make: vehicle.make,
        model: vehicle.model,
      },
      terms: {
        totalPrice: m(a.terms.totalPriceMinor),
        deposit: m(a.terms.depositMinor),
        financed: m(a.terms.financedMinor),
      },
      totals: {
        paidToDate: m(a.depositPaidMinor + paid),
        instalmentsPaid: m(paid),
        outstanding: balance.outstanding,
        overdue: balance.overdue,
        penaltiesOutstanding: balance.penaltiesOutstanding,
        chargesOutstanding: balance.chargesOutstanding,
        percentComplete: owedInAll === 0 ? 100 : Math.floor((paid / owedInAll) * 1000) / 10,
        daysInArrears: balance.daysInArrears,
        nextDue: balance.nextDue,
      },
      schedule: [...ledger.instalments]
        .sort((x, y) => x.number - y.number)
        .map((i) => ({
          number: i.number,
          dueOn: i.dueOn,
          amount: m(i.amountMinor),
          paid: m(i.paidMinor),
          waived: m(i.waivedMinor),
          rescheduled: m(i.rescheduledMinor),
          status: i.status,
        })),
      payments: (await deps.reporting.payments(a.id)).map(({ amountMinor, ...p }) => ({
        ...p,
        amount: m(amountMinor),
      })),
      penalties: balance.penalties,
      charges: balance.charges,
    };
  }

  private within<T>(
    actor: Principal,
    permission: PermissionKey,
    query: Readonly<{ branchId?: string }>,
    body: (
      ctx: Readonly<{
        filter: Readonly<{ branchIds: "all" | readonly string[]; branchId: string | null }>;
        today: string;
        m: (minor: number) => MoneyJson;
      }>,
    ) => Promise<T>,
  ): Promise<T> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (query.branchId !== undefined) await deps.scope.branch(actor, permission, query.branchId);
      return body({
        filter: {
          branchIds: deps.scope.branchesFor(actor, permission),
          branchId: query.branchId ?? null,
        },
        today: await deps.calendar.today(),
        m: await this.money(),
      });
    });
  }

  private async money(): Promise<(minor: number) => MoneyJson> {
    const base = await this.deps.posting.baseCurrency();
    return (minor) => Money.ofMinor(minor, base).toJSON();
  }
}
