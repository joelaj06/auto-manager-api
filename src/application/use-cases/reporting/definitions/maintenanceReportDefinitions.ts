import type { ParamValues, ReportTable } from "../../../../domain/reporting/Report.js";
import type { Principal } from "../../../authorization/Principal.js";
import type { ExpenseAdministration } from "../../expenses/ExpenseAdministration.js";
import type { MaintenanceReports } from "../../maintenance/MaintenanceReports.js";
import type { ServiceSchedule } from "../../maintenance/ServiceSchedule.js";
import type { Dashboards } from "../Dashboards.js";
import { PERIOD_PARAMS, periodOf, type ReportDefinition } from "../ReportDefinition.js";
import type { ReportContext } from "../ReportContext.js";
import { between, minor, minorOr, share, total, vehicleName, words } from "./cells.js";

/** Expenses by category with the top vehicles and what waits for approval (docs/14 §3). */
export class ExpenseSummaryReport implements ReportDefinition {
  readonly id = "expense_summary";
  readonly title = "Expense summary";
  readonly description =
    "Approved and paid expenses in the period by category with their share, the vehicles costing most and what waits for approval";
  readonly category = "maintenance" as const;
  readonly permission = "dashboards.expenses.view" as const;
  readonly params = PERIOD_PARAMS;

  constructor(private readonly dashboards: Dashboards) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const e = await this.dashboards.expenses(actor, periodOf(params));
    return {
      title: this.title,
      subtitle: between(e.period),
      currency: e.total.currency,
      columns: [
        { key: "by", header: "By", type: "text", width: 0.7 },
        { key: "name", header: "Name", type: "text", width: 1.8 },
        { key: "count", header: "Expenses", type: "number", width: 0.7 },
        { key: "amount", header: "Amount", type: "money", width: 1.2 },
        { key: "share", header: "Share", type: "percent", width: 0.7 },
      ],
      rows: [
        ...e.byCategory.map((c) => ({
          by: "category",
          name: c.name,
          count: c.count,
          amount: minor(c.amount),
          share: share(minor(c.amount), minor(e.total)),
        })),
        ...e.topVehicles.map((v) => ({
          by: "vehicle",
          name: vehicleName(v),
          count: null,
          amount: minor(v.amount),
          share: share(minor(v.amount), minor(e.total)),
        })),
      ],
      totals: { by: "Total", name: null, count: e.count, amount: minor(e.total), share: null },
      summary: [
        { label: "Total", value: e.total.formatted },
        { label: "Before tax", value: e.net.formatted },
        { label: "Tax", value: e.tax.formatted },
        {
          label: "Waiting for approval",
          value: `${e.pendingApproval.count}, ${e.pendingApproval.amount.formatted}`,
        },
      ],
    };
  }
}

/** Monthly budgets against what was spent (docs/14 §3). */
export class BudgetVsActualReport implements ReportDefinition {
  readonly id = "budget_vs_actual";
  readonly title = "Budget against actual";
  readonly description =
    "Each active budget for a month: the budget, what was spent, what remains, the share used and its level";
  readonly category = "maintenance" as const;
  readonly permission = "expenses.budgets.view" as const;
  readonly params = [{ key: "month", label: "Month", type: "month", required: false }] as const;

  constructor(
    private readonly expenses: ExpenseAdministration,
    private readonly context: ReportContext,
  ) {}

  async run(_actor: Principal, params: ParamValues): Promise<ReportTable> {
    const budgets = await this.expenses.budgets(params.month ?? null);
    const currency = await this.context.baseCurrency();
    const sum = (pick: (b: (typeof budgets)[number]) => number) => total(budgets, pick);
    return {
      title: this.title,
      subtitle: budgets[0]?.month ?? params.month ?? null,
      currency,
      columns: [
        { key: "name", header: "Budget", type: "text", width: 1.8 },
        { key: "budget", header: "Budget", type: "money" },
        { key: "spent", header: "Spent", type: "money" },
        { key: "remaining", header: "Remaining", type: "money" },
        { key: "percent", header: "Used", type: "percent", width: 0.7 },
        { key: "level", header: "Level", type: "text", width: 0.8 },
      ],
      rows: budgets.map((b) => ({
        name: b.budget.name,
        budget: minor(b.budget.monthlyAmount),
        spent: minor(b.spent),
        remaining: minor(b.remaining),
        percent: b.percent,
        level: b.level,
      })),
      totals: {
        name: "Total",
        budget: sum((b) => minor(b.budget.monthlyAmount)),
        spent: sum((b) => minor(b.spent)),
        remaining: sum((b) => minor(b.remaining)),
        percent: share(
          sum((b) => minor(b.spent)),
          sum((b) => minor(b.budget.monthlyAmount)),
        ),
        level: null,
      },
      summary: [
        { label: "Exceeded", value: String(budgets.filter((b) => b.level === "exceeded").length) },
        { label: "Warning", value: String(budgets.filter((b) => b.level === "warning").length) },
      ],
    };
  }
}

/** Maintenance cost per vehicle with cost per km and preventive against corrective (docs/14 §3). */
export class MaintenanceCostReport implements ReportDefinition {
  readonly id = "maintenance_cost";
  readonly title = "Maintenance cost";
  readonly description =
    "Per vehicle: work orders completed, cost, cost per km or mile and failures, with cost by kind and type and preventive against corrective work";
  readonly category = "maintenance" as const;
  readonly permission = "dashboards.maintenance.view" as const;
  readonly params = PERIOD_PARAMS;

  constructor(private readonly maintenance: MaintenanceReports) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const k = await this.maintenance.kpis(actor, periodOf(params));
    const c = k.cost;
    return {
      title: this.title,
      subtitle: between(k.period),
      currency: c.total.currency,
      columns: [
        { key: "vehicle", header: "Vehicle", type: "text", width: 1.4 },
        { key: "model", header: "Make and model", type: "text", width: 1.6 },
        { key: "workOrders", header: "Work orders", type: "number", width: 0.7 },
        { key: "cost", header: "Cost", type: "money" },
        { key: "distance", header: "Distance", type: "number" },
        { key: "costPerDistance", header: "Cost per km/mi", type: "money" },
        { key: "failures", header: "Failures", type: "number", width: 0.6 },
      ],
      rows: k.byVehicle.map((v) => ({
        vehicle: vehicleName(v),
        model: `${v.make} ${v.model}`,
        workOrders: v.workOrders,
        cost: minor(v.cost),
        distance: v.distance.value,
        costPerDistance: minorOr(v.costPerDistance),
        failures: v.failures,
      })),
      totals: {
        vehicle: "Total",
        model: `${k.vehicles} vehicles`,
        workOrders: k.workOrders.completed,
        cost: minor(c.total),
        distance: k.distanceKm,
        costPerDistance: minorOr(c.perKm),
        failures: k.failures.count,
      },
      summary: [
        { label: "Recovered from drivers, renters and insurers", value: c.recovered.formatted },
        { label: "Borne by the business", value: c.business.formatted },
        { label: "Labour", value: c.byKind.labour.formatted },
        { label: "Parts", value: c.byKind.part.formatted },
        { label: "Sublet", value: c.byKind.sublet.formatted },
        { label: "Other", value: c.byKind.other.formatted },
        ...c.byType.map((t) => ({
          label: `${words(t.type)} (${t.workOrders})`,
          value: t.cost.formatted,
        })),
        {
          label: "Preventive share",
          value:
            k.preventive.preventivePercent === null ? "–" : `${k.preventive.preventivePercent}%`,
        },
        { label: "Per vehicle-month", value: c.perVehicleMonth?.formatted ?? "–" },
      ],
    };
  }
}

/** Days off the road per vehicle and availability (docs/14 §3). */
export class DowntimeReport implements ReportDefinition {
  readonly id = "downtime";
  readonly title = "Downtime";
  readonly description =
    "Per vehicle: days off the road and availability in the period, with failures and the mean days between them";
  readonly category = "maintenance" as const;
  readonly permission = "dashboards.maintenance.view" as const;
  readonly params = PERIOD_PARAMS;

  constructor(private readonly maintenance: MaintenanceReports) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const k = await this.maintenance.kpis(actor, periodOf(params));
    const vehicles = [...k.byVehicle].sort((a, b) => b.downtimeDays - a.downtimeDays);
    return {
      title: this.title,
      subtitle: between(k.period),
      currency: k.cost.total.currency,
      columns: [
        { key: "vehicle", header: "Vehicle", type: "text", width: 1.4 },
        { key: "model", header: "Make and model", type: "text", width: 1.6 },
        { key: "downtime", header: "Days off the road", type: "number" },
        { key: "availability", header: "Availability", type: "percent" },
        { key: "failures", header: "Failures", type: "number", width: 0.6 },
      ],
      rows: vehicles.map((v) => ({
        vehicle: vehicleName(v),
        model: `${v.make} ${v.model}`,
        downtime: v.downtimeDays,
        availability: v.availabilityPercent,
        failures: v.failures,
      })),
      totals: {
        vehicle: "Total",
        model: `${k.vehicles} vehicles`,
        downtime: k.downtime.days,
        availability: k.downtime.availabilityPercent,
        failures: k.failures.count,
      },
      summary: [
        { label: "Off the road now", value: String(k.workOrders.offRoad) },
        {
          label: "Mean days between failures",
          value: k.failures.meanDaysBetween === null ? "–" : String(k.failures.meanDaysBetween),
        },
      ],
    };
  }
}

/** Services coming up, due and overdue (docs/14 §3). */
export class ServiceDueReport implements ReportDefinition {
  readonly id = "service_due";
  readonly title = "Services due";
  readonly description =
    "Service tasks upcoming, due and overdue per vehicle with the due odometer or date and what is left";
  readonly category = "maintenance" as const;
  readonly permission = "maintenance.view" as const;
  readonly params = [
    {
      key: "status",
      label: "Status",
      type: "enum",
      required: false,
      options: ["upcoming", "due", "overdue"],
    },
    { key: "branchId", label: "Branch", type: "uuid", required: false },
  ] as const;

  constructor(
    private readonly schedule: ServiceSchedule,
    private readonly context: ReportContext,
  ) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const items = await this.schedule.due(actor, {
      ...(params.status === undefined
        ? {}
        : { status: params.status as "upcoming" | "due" | "overdue" }),
      ...(params.branchId === undefined ? {} : { branchId: params.branchId }),
      limit: 2_000,
    });
    const shown =
      params.status === undefined ? items.filter((i) => i.status !== "scheduled") : items;
    const count = (status: string) => shown.filter((i) => i.status === status).length;
    return {
      title: this.title,
      subtitle: null,
      currency: await this.context.baseCurrency(),
      columns: [
        { key: "status", header: "Status", type: "text", width: 0.7 },
        { key: "vehicle", header: "Vehicle", type: "text", width: 1.4 },
        { key: "name", header: "Make and model", type: "text", width: 1.4 },
        { key: "plan", header: "Plan", type: "text" },
        { key: "task", header: "Task", type: "text", width: 1.4 },
        { key: "odometer", header: "Odometer", type: "number" },
        { key: "dueKm", header: "Due at", type: "number" },
        { key: "kmLeft", header: "Left", type: "number", width: 0.6 },
        { key: "dueOn", header: "Due on", type: "date" },
        { key: "daysLeft", header: "Days left", type: "number", width: 0.6 },
      ],
      rows: shown.map((i) => ({
        status: i.status,
        vehicle: vehicleName(i.vehicle),
        name: i.vehicle.name,
        plan: i.plan.name,
        task: i.task.name,
        odometer: i.vehicle.odometer,
        dueKm: i.dueKm,
        kmLeft: i.kmLeft,
        dueOn: i.dueOn,
        daysLeft: i.daysLeft,
      })),
      totals: null,
      summary: [
        { label: "Overdue", value: String(count("overdue")) },
        { label: "Due", value: String(count("due")) },
        { label: "Upcoming", value: String(count("upcoming")) },
      ],
    };
  }
}

/** Expenses submitted in the period: waiting, approved or rejected, and by whom (docs/14 §3). */
export class ExpenseApprovalsReport implements ReportDefinition {
  readonly id = "expense_approvals";
  readonly title = "Expense approvals";
  readonly description =
    "Expenses dated in the period waiting for approval first, then approved, paid and rejected, with who submitted and who decided";
  readonly category = "maintenance" as const;
  readonly permission = "expenses.list" as const;
  readonly params = PERIOD_PARAMS;
  readonly landscape = true;

  constructor(private readonly context: ReportContext) {}

  run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    return this.context.within(actor, this.permission, params, async (c) => {
      const expenses = await c.queries.expenseApprovals(c.filter, c.range.from, c.range.to);
      const waiting = expenses.filter((e) => e.status === "submitted");
      return {
        title: this.title,
        subtitle: between(c.range),
        currency: c.base,
        columns: [
          { key: "status", header: "Status", type: "text", width: 0.7 },
          { key: "number", header: "Number", type: "text" },
          { key: "date", header: "Date", type: "date" },
          { key: "category", header: "Category", type: "text" },
          { key: "description", header: "Description", type: "text", width: 1.8 },
          { key: "payee", header: "Payee", type: "text" },
          { key: "branch", header: "Branch", type: "text" },
          { key: "amount", header: "Amount", type: "money" },
          { key: "submittedBy", header: "Submitted by", type: "text" },
          { key: "decidedBy", header: "Decided by", type: "text" },
          { key: "decidedAt", header: "Decided", type: "text" },
          { key: "reason", header: "Reason", type: "text" },
        ],
        rows: expenses.map((e) => ({
          status: e.status === "submitted" ? "waiting" : e.status,
          number: e.number,
          date: e.expenseDate,
          category: e.category,
          description: e.description,
          payee: e.payeeName,
          branch: e.branchName,
          amount: e.amountBaseMinor,
          submittedBy: e.submittedBy,
          decidedBy: e.decidedBy,
          decidedAt: e.decidedAt === null ? null : c.timeOf(e.decidedAt),
          reason: e.rejectionReason,
        })),
        totals: null,
        summary: [
          {
            label: "Waiting",
            value: `${waiting.length}, ${c.formatted(total(waiting, (e) => e.amountBaseMinor))}`,
          },
          {
            label: "Approved or paid",
            value: String(
              expenses.filter((e) => e.status === "approved" || e.status === "paid").length,
            ),
          },
          {
            label: "Rejected",
            value: String(expenses.filter((e) => e.status === "rejected").length),
          },
        ],
      };
    });
  }
}
