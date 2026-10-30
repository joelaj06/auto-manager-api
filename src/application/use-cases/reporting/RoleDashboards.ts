import { DomainError } from "../../../domain/errors/DomainError.js";
import {
  checkWidgets,
  DASHBOARD_ROLES,
  type DashboardRole,
} from "../../../domain/reporting/DashboardLayout.js";
import { checkParams, type ParamValues } from "../../../domain/reporting/Report.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import { PermissionDeniedError } from "../../errors/AuthErrors.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IDashboardLayouts } from "../../ports/IDashboardLayouts.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { DealerLeads } from "../dealer/DealerLeads.js";
import type { NotificationCenter } from "../notifications/NotificationCenter.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { OperationsBoard } from "../remittances/OperationsBoard.js";
import type { RentalReports } from "../rentals/RentalReports.js";
import type { Dashboards } from "./Dashboards.js";
import type { ReportDefinition } from "./ReportDefinition.js";
import { tableView } from "./Reports.js";

/** Rows of a report shown in a widget (the report itself has them all). */
const WIDGET_ROWS = 10;

/** A piece of a role dashboard, read from an existing dashboard or catalogue report. */
type Widget = Readonly<{
  key: string;
  title: string;
  /** Whoever lacks it does not see the widget. */
  permission: PermissionKey | null;
  load(actor: Principal, today: string): Promise<unknown>;
}>;

export type WidgetEntry = Readonly<{
  key: string;
  title: string;
  permission: PermissionKey | null;
}>;

export type RoleLayoutView = Readonly<{
  role: DashboardRole;
  widgets: readonly WidgetEntry[];
  /** False while the role shows the default widgets. */
  customised: boolean;
  updatedAt: Date | null;
}>;

export type RoleDashboardView = Readonly<{
  role: DashboardRole;
  today: string;
  widgets: readonly Readonly<{
    key: string;
    title: string;
    data: unknown;
    /** Why the widget could not be read (its data is then null). */
    error: string | null;
  }>[];
}>;

/** The widgets of each role's dashboard until the business changes them (docs/14 §4). */
export const DEFAULT_LAYOUTS: Readonly<Record<DashboardRole, readonly string[]>> = {
  owner: ["kpis", "revenue_trend", "vehicle_ranking", "alerts"],
  fleet_manager: ["operations_board", "compliance", "service_due", "remittances_today"],
  rental_agent: ["rental_board", "rental_balances", "alerts"],
  sales_executive: ["my_leads", "lead_funnel", "my_commissions"],
  accountant: ["receivables", "payments_today", "expense_approvals", "cash_sessions"],
};

/**
 * Role-based dashboards (docs/14 §4, decision 478): a list of widgets for the owner, fleet
 * manager, rental agent, sales executive and accountant, each read from the dashboards and
 * catalogue reports already there with their permissions and branch scope; a widget the viewer
 * may not see is left out. The business may change a role's widgets, or go back to the defaults.
 */
export class RoleDashboards {
  private readonly widgets: readonly Widget[];

  constructor(
    private readonly deps: Readonly<{
      definitions: readonly ReportDefinition[];
      dashboards: Dashboards;
      board: OperationsBoard;
      rentals: RentalReports;
      leads: DealerLeads;
      notifications: NotificationCenter;
      layouts: IDashboardLayouts;
      calendar: TenantCalendar;
      unitOfWork: IUnitOfWork;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      clock: IClock;
    }>,
  ) {
    const monthStart = (today: string) => `${today.slice(0, 7)}-01`;
    this.widgets = [
      {
        key: "kpis",
        title: "This month against the last",
        permission: "dashboards.overview.view",
        load: async (actor, today) => {
          const o = await deps.dashboards.overview(actor, { from: monthStart(today), to: today });
          return {
            period: o.period,
            revenue: o.revenue,
            costs: o.costs.total,
            net: o.net,
            cash: o.cash,
            previous: o.previous,
          };
        },
      },
      {
        key: "revenue_trend",
        title: "Revenue, costs and net over 12 months",
        permission: "dashboards.overview.view",
        load: async (actor, today) => {
          const [year, month] = today.split("-").map(Number) as [number, number];
          const first = new Date(Date.UTC(year, month - 12, 1));
          const from = first.toISOString().slice(0, 10);
          const o = await deps.dashboards.overview(actor, { from, to: today, groupBy: "month" });
          return { period: o.period, series: o.series };
        },
      },
      {
        key: "vehicle_ranking",
        title: "Most and least profitable vehicles this month",
        permission: "dashboards.vehicles.view",
        load: async (actor, today) => {
          const f = await deps.dashboards.vehicleProfits(actor, {
            from: monthStart(today),
            to: today,
          });
          return {
            period: f.period,
            totals: f.totals,
            top: f.vehicles.slice(0, 5),
            bottom: f.vehicles.length > 5 ? f.vehicles.slice(-5).reverse() : [],
          };
        },
      },
      {
        key: "alerts",
        title: "Unread notifications",
        permission: null,
        load: (actor) => deps.notifications.list(actor, { unreadOnly: true, limit: WIDGET_ROWS }),
      },
      {
        key: "operations_board",
        title: "Today's operations",
        permission: "operations.board.view",
        load: (actor, today) => deps.board.board(actor, { date: today }),
      },
      this.report("compliance", "Documents and licences expiring in 30 days", "compliance", () => ({
        within: "30",
      })),
      this.report("service_due", "Services due and overdue", "service_due", () => ({})),
      {
        key: "remittances_today",
        title: "Remittances today",
        permission: "dashboards.remittances.view",
        load: (actor, today) => deps.dashboards.remittances(actor, { from: today, to: today }),
      },
      {
        key: "rental_board",
        title: "Today's pickups, returns and overdue rentals",
        permission: "rentals.view",
        load: (actor, today) => deps.rentals.board(actor, { date: today }),
      },
      this.report("rental_balances", "Rental balances owed", "rental_balances", () => ({})),
      {
        key: "my_leads",
        title: "My open leads",
        permission: "dealer.leads.view",
        load: (actor) =>
          deps.leads.list(actor, {
            assignedTo: actor.userId,
            stages: ["new", "contacted", "appointment", "test_drive", "negotiation"],
            limit: WIDGET_ROWS,
          }),
      },
      this.report("lead_funnel", "Lead funnel this month", "dealer_lead_funnel", (today) => ({
        from: monthStart(today),
        to: today,
      })),
      this.report("my_commissions", "Commissions this month", "dealer_commissions", (today) => ({
        month: today.slice(0, 7),
      })),
      this.report("receivables", "Receivables ageing", "receivables_ageing", (today) => ({
        asOf: today,
      })),
      this.report("payments_today", "Payments today", "payments_register", (today) => ({
        from: today,
        to: today,
      })),
      this.report(
        "expense_approvals",
        "Expense approvals this month",
        "expense_approvals",
        (today) => ({
          from: monthStart(today),
          to: today,
        }),
      ),
      this.report(
        "cash_sessions",
        "Cash sessions this month",
        "cash_session_variance",
        (today) => ({
          from: monthStart(today),
          to: today,
        }),
      ),
    ];
  }

  /** Every widget, for building a layout. */
  catalogue(): WidgetEntry[] {
    return this.widgets.map(({ key, title, permission }) => ({ key, title, permission }));
  }

  layouts(): Promise<RoleLayoutView[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const stored = new Map((await deps.layouts.list()).map((l) => [l.role, l]));
      return DASHBOARD_ROLES.map((role) => {
        const own = stored.get(role);
        return this.layoutView(role, own?.widgets ?? null, own?.updatedAt ?? null);
      });
    });
  }

  /** The role's dashboard as the viewer may see it. */
  async dashboard(actor: Principal, role: DashboardRole): Promise<RoleDashboardView> {
    const { deps } = this;
    const { keys, today } = await deps.unitOfWork.run(async () => ({
      keys: (await deps.layouts.get(role))?.widgets ?? DEFAULT_LAYOUTS[role],
      today: await deps.calendar.today(),
    }));
    const widgets: RoleDashboardView["widgets"][number][] = [];
    // One at a time: each reads in its own unit of work.
    for (const key of keys) {
      const widget = this.widgets.find((w) => w.key === key);
      if (widget === undefined) continue;
      if (widget.permission !== null && actor.grantFor(widget.permission) === undefined) continue;
      try {
        widgets.push({
          key,
          title: widget.title,
          data: await widget.load(actor, today),
          error: null,
        });
      } catch (error) {
        if (!(error instanceof DomainError || error instanceof ApplicationError)) throw error;
        if (error instanceof PermissionDeniedError) continue;
        widgets.push({ key, title: widget.title, data: null, error: error.message });
      }
    }
    return { role, today, widgets };
  }

  setLayout(
    actor: Principal,
    role: DashboardRole,
    keys: readonly string[],
  ): Promise<RoleLayoutView> {
    const { deps } = this;
    const widgets = checkWidgets(
      keys,
      this.widgets.map((w) => w.key),
    );
    return deps.unitOfWork.run(async () => {
      const before = (await deps.layouts.get(role))?.widgets ?? DEFAULT_LAYOUTS[role];
      const now = deps.clock.now();
      await deps.layouts.save({ role, widgets, updatedBy: actor.userId, updatedAt: now });
      await recordUserAction(deps, actor.userId, {
        action: "dashboard.layout_changed",
        entityType: "dashboard_layout",
        entityId: role,
        before: { widgets: before },
        after: { widgets },
      });
      return this.layoutView(role, widgets, now);
    });
  }

  /** Back to the default widgets. */
  resetLayout(actor: Principal, role: DashboardRole): Promise<RoleLayoutView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const stored = await deps.layouts.get(role);
      if (stored !== null) {
        await deps.layouts.remove(role);
        await recordUserAction(deps, actor.userId, {
          action: "dashboard.layout_reset",
          entityType: "dashboard_layout",
          entityId: role,
          before: { widgets: stored.widgets },
        });
      }
      return this.layoutView(role, null, null);
    });
  }

  /** A widget of the first rows of a catalogue report, run with its permission and scope. */
  private report(
    key: string,
    title: string,
    reportId: string,
    params: (today: string) => ParamValues,
  ): Widget {
    const definition = this.deps.definitions.find((d) => d.id === reportId);
    if (definition === undefined) throw new Error(`No report ${reportId} for widget ${key}`);
    return {
      key,
      title,
      permission: definition.permission,
      load: async (actor, today) => {
        const table = tableView(
          definition.id,
          await definition.run(actor, checkParams(definition.params, params(today))),
        );
        return { ...table, rows: table.rows.slice(0, WIDGET_ROWS), rowCount: table.rows.length };
      },
    };
  }

  private layoutView(
    role: DashboardRole,
    own: readonly string[] | null,
    updatedAt: Date | null,
  ): RoleLayoutView {
    const keys = own ?? DEFAULT_LAYOUTS[role];
    return {
      role,
      widgets: keys.flatMap((key) => {
        const w = this.widgets.find((x) => x.key === key);
        return w === undefined ? [] : [{ key: w.key, title: w.title, permission: w.permission }];
      }),
      customised: own !== null,
      updatedAt,
    };
  }
}
