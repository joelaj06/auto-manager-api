import {
  LEAD_STAGES,
  Lead,
  LeadRuleError,
  conversionRate,
  type LeadDetails,
  type LeadProps,
  type LeadSource,
  type LeadStage,
} from "../../../domain/dealer/Lead.js";
import { Money } from "../../../domain/money/Money.js";
import { PhoneNumber } from "../../../domain/value-objects/PhoneNumber.js";
import type { Principal } from "../../authorization/Principal.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type {
  ActivityKind,
  FunnelRow,
  ILeads,
  LeadActivity,
  LeadTask,
  ListedVehicle,
} from "../../ports/IDealerSales.js";
import type { IDealerStock } from "../../ports/IDealerStock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type {
  INotificationSettingsStore,
  IRecipientDirectory,
} from "../../ports/INotifications.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import { localMidnight } from "../../services/TenantLocalTime.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { Notifier } from "../notifications/Notifier.js";
import type { DocumentNumbering } from "../reference/DocumentNumbering.js";
import { recordUserAction } from "../reference/userAudit.js";

export class LeadNotFoundError extends ApplicationError {
  readonly code = "LEAD_NOT_FOUND";
  constructor() {
    super("Lead not found");
  }
}

/** Who may take leads in a branch: those who can open leads there (decision 439). */
export const TAKES_LEADS: PermissionKey = "dealer.leads.create";
/** Contact with the person: a new lead becomes contacted. */
const CONTACT: readonly ActivityKind[] = ["call", "message", "whatsapp", "email", "visit"];
export const LOGGED_ACTIVITIES = ["call", "message", "whatsapp", "email", "visit", "note"] as const;

export type LeadInput = Readonly<{
  source: LeadSource;
  name: string;
  phone?: string | null;
  email?: string | null;
  customerId?: string | null;
  vehicleId?: string | null;
  make?: string | null;
  model?: string | null;
  yearFrom?: number | null;
  yearTo?: number | null;
  budgetMax?: string | null;
  notifyMatches?: boolean;
  notes?: string | null;
}>;

/** A user id, nobody (null), or `"round_robin"`: the next in the branch's rotation. */
export type Assignee = string | null;

export type LeadQuery = Readonly<{
  branchId?: string;
  assignedTo?: string;
  unassigned?: boolean;
  stages?: readonly LeadStage[];
  sources?: readonly LeadSource[];
  search?: string;
  limit: number;
  beforeId?: string;
}>;

export type LeadView = Omit<LeadProps, "budgetMaxMinor"> &
  Readonly<{ budgetMax: ReturnType<Money["toJSON"]> | null }>;

export type LeadDetailView = LeadView &
  Readonly<{ activities: readonly LeadActivity[]; tasks: readonly LeadTask[] }>;

type FunnelLine = Readonly<{
  leads: number;
  open: number;
  won: number;
  lost: number;
  conversion: string | null;
}>;

export type Funnel = Readonly<{
  from: string;
  to: string;
  stages: Readonly<Record<LeadStage, number>>;
  total: FunnelLine;
  bySource: readonly (FunnelLine & Readonly<{ source: LeadSource }>)[];
  byAssignee: readonly (FunnelLine & Readonly<{ userId: string | null }>)[];
}>;

type Deps = Readonly<{
  unitOfWork: IUnitOfWork;
  leads: ILeads;
  stock: IDealerStock;
  recipients: IRecipientDirectory;
  settings: INotificationSettingsStore;
  notifier: Notifier;
  organisation: IOrganisationSettings;
  scope: BranchScope;
  numbering: DocumentNumbering;
  calendar: TenantCalendar;
  auditTrail: IAuditTrail;
  requestContext: IRequestContext;
  ids: IIdGenerator;
  clock: IClock;
}>;

/**
 * Whether the caller reaches a lead with a permission: own scope means the leads assigned to
 * them, otherwise the lead's branch (decision 438).
 */
export function reachesLead(
  actor: Principal,
  scope: BranchScope,
  permission: PermissionKey,
  lead: Lead,
): boolean {
  const grant = actor.grantFor(permission);
  if (grant === undefined) return false;
  const p = lead.snapshot();
  if (grant.scope === "own") return p.assignedTo === actor.userId;
  return scope.can(actor, permission, p.branchId);
}

/** Logs something done for a lead by another module and moves it forward (test drive, quote). */
export async function noteOnLead(
  deps: Readonly<{ leads: ILeads; ids: IIdGenerator; clock: IClock }>,
  leadId: string,
  entry: Readonly<{
    kind: ActivityKind;
    note: string;
    details: LeadActivity["details"];
    userId: string | null;
    advanceTo?: LeadStage;
  }>,
): Promise<void> {
  const lead = await deps.leads.lock(leadId);
  if (lead === null) return;
  const now = deps.clock.now();
  await deps.leads.addActivity({
    id: deps.ids.next(),
    leadId,
    kind: entry.kind,
    note: entry.note,
    details: entry.details,
    occurredAt: now,
    recordedBy: entry.userId,
    recordedAt: now,
  });
  if (entry.advanceTo !== undefined) {
    const from = lead.stage;
    if (lead.advanceTo(entry.advanceTo, now)) {
      await deps.leads.update(lead);
      await deps.leads.addActivity({
        id: deps.ids.next(),
        leadId,
        kind: "stage",
        note: null,
        details: { from, to: entry.advanceTo },
        occurredAt: now,
        recordedBy: entry.userId,
        recordedAt: now,
      });
    }
  }
}

/**
 * Leads and the sales pipeline (docs/10 §4): capture from any channel, assignment by hand or in
 * turn from the branch's pool, stages with a lost reason, the activity log, follow-up tasks, saved
 * searches matched against listed stock and the funnel by source and by sales executive
 * (decisions 437–444).
 */
export class DealerLeads {
  constructor(private readonly deps: Deps) {}

  list(actor: Principal, query: LeadQuery): Promise<LeadView[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const own = actor.grantFor("dealer.leads.view")?.scope === "own";
      if (query.branchId !== undefined && !own)
        await deps.scope.branch(actor, "dealer.leads.view", query.branchId);
      const base = await this.base();
      const leads = await deps.leads.list({
        ...query,
        branchIds: own ? "all" : deps.scope.branchesFor(actor, "dealer.leads.view"),
        ...(own ? { assignedTo: actor.userId } : {}),
      });
      return leads.map((l) => view(l, base));
    });
  }

  get(actor: Principal, id: string): Promise<LeadDetailView> {
    return this.deps.unitOfWork.run(async () =>
      this.detail(await this.reach(actor, id, "dealer.leads.view")),
    );
  }

  create(
    actor: Principal,
    input: LeadInput & Readonly<{ branchId?: string; assignTo?: Assignee }>,
  ): Promise<LeadDetailView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const branchId =
        input.branchId ?? (await deps.scope.defaultBranch(actor, "dealer.leads.create", "lead"));
      await deps.scope.branch(actor, "dealer.leads.create", branchId);
      const now = deps.clock.now();
      const lead = Lead.open({
        ...(await this.details(input, await this.base())),
        id: deps.ids.next(),
        number: await deps.numbering.next("lead", now),
        branchId,
        createdBy: actor.userId,
        now,
      });
      await deps.leads.insert(lead);
      // Unsaid: the next in the branch's rotation when the one entering it hands leads out and
      // the branch has one, else whoever entered it (decision 439).
      const assigns = deps.scope.can(actor, "dealer.leads.assign", branchId);
      let assignee: Assignee | undefined = input.assignTo;
      if (assignee === undefined)
        assignee =
          assigns && (await deps.leads.pool(branchId)).length > 0 ? "round_robin" : actor.userId;
      if (assignee !== actor.userId && !assigns)
        throw new LeadRuleError("Only those who assign leads give them to someone else");
      if (assignee !== null) await this.hand(actor, lead, assignee);
      await this.audit(actor, "lead.created", lead);
      return this.detail(lead);
    });
  }

  revise(actor: Principal, id: string, input: LeadInput): Promise<LeadDetailView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const lead = await this.reach(actor, id, "dealer.leads.update", true);
      lead.revise(await this.details(input, await this.base()), deps.clock.now());
      await deps.leads.update(lead);
      await this.audit(actor, "lead.revised", lead);
      return this.detail(lead);
    });
  }

  move(
    actor: Principal,
    id: string,
    input: Readonly<{ stage: LeadStage; reason?: string | null }>,
  ): Promise<LeadDetailView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const lead = await this.reach(actor, id, "dealer.leads.update", true);
      const now = deps.clock.now();
      const from = lead.moveTo(input.stage, input.reason ?? null, now);
      await deps.leads.update(lead);
      await this.log(actor, lead, "stage", input.reason ?? null, { from, to: input.stage }, now);
      await this.audit(actor, "lead.stage_changed", lead, { from, to: input.stage });
      return this.detail(lead);
    });
  }

  assign(actor: Principal, id: string, assignee: Assignee): Promise<LeadDetailView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const lead = await this.reach(actor, id, "dealer.leads.assign", true);
      if (assignee === null) {
        const before = lead.assign(null, deps.clock.now());
        await deps.leads.update(lead);
        await this.log(actor, lead, "assignment", null, { from: before, to: null });
      } else await this.hand(actor, lead, assignee);
      await this.audit(actor, "lead.assigned", lead);
      return this.detail(lead);
    });
  }

  logActivity(
    actor: Principal,
    id: string,
    input: Readonly<{
      kind: (typeof LOGGED_ACTIVITIES)[number];
      note?: string | null;
      occurredAt?: Date;
    }>,
  ): Promise<LeadDetailView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const lead = await this.reach(actor, id, "dealer.leads.update", true);
      const now = deps.clock.now();
      const at = input.occurredAt ?? now;
      if (at > now) throw new LeadRuleError("Log what has happened (not in the future)");
      const note = input.note?.trim() || null;
      if (input.kind === "note" && note === null) throw new LeadRuleError("Write the note");
      await this.log(actor, lead, input.kind, note, {}, at);
      if (CONTACT.includes(input.kind) && lead.stage === "new") {
        lead.moveTo("contacted", null, now);
        await deps.leads.update(lead);
        await this.log(actor, lead, "stage", null, { from: "new", to: "contacted" }, now);
      }
      return this.detail(lead);
    });
  }

  addTask(
    actor: Principal,
    id: string,
    input: Readonly<{ title: string; dueOn: string; assignedTo?: string | null }>,
  ): Promise<LeadDetailView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const lead = await this.reach(actor, id, "dealer.leads.update", true);
      if (!lead.isOpen) throw new LeadRuleError("The lead is closed");
      const title = input.title.trim();
      if (title === "") throw new LeadRuleError("Say what to do");
      const assignedTo = input.assignedTo ?? lead.snapshot().assignedTo ?? actor.userId;
      if (assignedTo !== actor.userId) await this.assertTakesLeads(assignedTo, lead);
      await deps.leads.saveTask({
        id: deps.ids.next(),
        leadId: lead.id,
        title,
        dueOn: input.dueOn,
        assignedTo,
        doneAt: null,
        doneBy: null,
        createdBy: actor.userId,
        createdAt: deps.clock.now(),
      });
      return this.detail(lead);
    });
  }

  completeTask(actor: Principal, id: string, taskId: string): Promise<LeadDetailView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const lead = await this.reach(actor, id, "dealer.leads.update", true);
      const task = await deps.leads.task(taskId);
      if (task === null || task.leadId !== lead.id) throw new LeadNotFoundError();
      if (task.doneAt !== null) throw new LeadRuleError("The task is already done");
      const now = deps.clock.now();
      await deps.leads.saveTask({ ...task, doneAt: now, doneBy: actor.userId });
      await this.log(actor, lead, "note", `Done: ${task.title}`, { taskId }, now);
      return this.detail(lead);
    });
  }

  /** Listed stock that fits the lead's saved search now. */
  matches(actor: Principal, id: string): Promise<ListedVehicle[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const lead = await this.reach(actor, id, "dealer.leads.view");
      if (lead.snapshot().make === null) return [];
      const probe = Lead.restore({ ...lead.snapshot(), notifyMatches: true });
      return (await deps.leads.listedVehicles()).filter((v) => probe.matches(v));
    });
  }

  pool(actor: Principal, branchId: string): Promise<string[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      await deps.scope.branch(actor, "dealer.leads.assign", branchId);
      return deps.leads.pool(branchId);
    });
  }

  /** Who takes new leads of the branch in turn (in this order). */
  setPool(actor: Principal, branchId: string, userIds: readonly string[]): Promise<string[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      await deps.scope.branch(actor, "dealer.leads.assign", branchId);
      const unique = [...new Set(userIds)];
      const takers = new Set(
        (await deps.recipients.staffWith(TAKES_LEADS, branchId)).map((r) => r.userId),
      );
      for (const userId of unique)
        if (!takers.has(userId))
          throw new LeadRuleError("Everyone in the rotation must be able to take leads there");
      await deps.leads.setPool(branchId, unique);
      await recordUserAction(deps, actor.userId, {
        action: "lead.pool_changed",
        entityType: "branch",
        entityId: branchId,
        after: { userIds: unique },
      });
      return deps.leads.pool(branchId);
    });
  }

  /** Leads created in the period by where they are now, by source and by sales executive. */
  funnel(
    actor: Principal,
    query: Readonly<{ from: string; to: string; branchId?: string }>,
  ): Promise<Funnel> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (query.to < query.from) throw new LeadRuleError("The period ends after it starts");
      // Own scope: the funnel of the leads assigned to them.
      const own = actor.grantFor("dealer.leads.view")?.scope === "own";
      let branchIds = own ? "all" : deps.scope.branchesFor(actor, "dealer.leads.view");
      if (query.branchId !== undefined && !own) {
        await deps.scope.branch(actor, "dealer.leads.view", query.branchId);
        branchIds = [query.branchId];
      }
      const { timezone } = await deps.organisation.get();
      const rows = await deps.leads.funnel({
        branchIds,
        ...(own ? { assignedTo: actor.userId } : {}),
        from: localMidnight(query.from, timezone),
        until: localMidnight(next(query.to), timezone),
      });
      const stages = Object.fromEntries(LEAD_STAGES.map((s) => [s, 0])) as Record<
        LeadStage,
        number
      >;
      for (const r of rows) stages[r.stage] += r.leads;
      const sources = [...new Set(rows.map((r) => r.source))].sort();
      const users = [...new Set(rows.map((r) => r.assignedTo))];
      return {
        from: query.from,
        to: query.to,
        stages,
        total: line(rows),
        bySource: sources.map((source) => ({
          source,
          ...line(rows.filter((r) => r.source === source)),
        })),
        byAssignee: users.map((userId) => ({
          userId,
          ...line(rows.filter((r) => r.assignedTo === userId)),
        })),
      };
    });
  }

  /** The lead given to a user (or the next in turn), who is told. */
  private async hand(
    actor: Principal,
    lead: Lead,
    /** A user id or `"round_robin"`. */
    assignee: string,
  ): Promise<void> {
    const { deps } = this;
    const p = lead.snapshot();
    let userId = assignee;
    if (assignee === "round_robin") {
      const takers = new Set(
        (await deps.recipients.staffWith(TAKES_LEADS, p.branchId)).map((r) => r.userId),
      );
      const pool = (await deps.leads.pool(p.branchId)).filter((u) => takers.has(u));
      if (pool.length === 0)
        throw new LeadRuleError("No one in the branch's rotation can take leads");
      const last = await deps.leads.lastAssigned(pool);
      userId = pool.reduce((best, u) => {
        const a = last.get(u) ?? null;
        const b = last.get(best) ?? null;
        if (a === null) return b === null ? best : u;
        return b !== null && a < b ? u : best;
      });
    } else await this.assertTakesLeads(assignee, lead);
    const now = deps.clock.now();
    const before = lead.assign(userId, now);
    await deps.leads.update(lead);
    await this.log(actor, lead, "assignment", null, {
      from: before,
      to: userId,
      roundRobin: assignee === "round_robin",
    });
    if (userId !== actor.userId)
      await deps.notifier.users(await deps.settings.get(), {
        rule: "lead_assigned",
        userIds: [userId],
        dedupeKey: `lead_assigned:${lead.id}:${now.getTime()}`,
        title: `New lead ${p.number}: ${p.name}`,
        body: `${p.name} (${p.source.replaceAll("_", " ")}) is yours to follow up${p.make === null ? "" : `, after a ${[p.make, p.model].filter((x) => x !== null).join(" ")}`}.`,
        severity: "info",
        data: { leadId: lead.id },
      });
  }

  private async assertTakesLeads(userId: string, lead: Lead): Promise<void> {
    const takers = await this.deps.recipients.staffWith(TAKES_LEADS, lead.snapshot().branchId);
    if (!takers.some((t) => t.userId === userId))
      throw new LeadRuleError("They cannot take leads in the lead's branch");
  }

  private async details(input: LeadInput, base: string): Promise<LeadDetails> {
    const { deps } = this;
    if (
      input.customerId !== undefined &&
      input.customerId !== null &&
      (await deps.leads.customer(input.customerId)) === null
    )
      throw new LeadRuleError("The customer was not found");
    if (
      input.vehicleId !== undefined &&
      input.vehicleId !== null &&
      (await deps.stock.get(input.vehicleId)) === null
    )
      throw new LeadRuleError("The vehicle is not in stock");
    const phone = input.phone?.trim() ? PhoneNumber.parse(input.phone).value : null;
    return {
      source: input.source,
      name: input.name,
      phone,
      email: input.email ?? null,
      customerId: input.customerId ?? null,
      vehicleId: input.vehicleId ?? null,
      make: input.make ?? null,
      model: input.model ?? null,
      yearFrom: input.yearFrom ?? null,
      yearTo: input.yearTo ?? null,
      budgetMaxMinor:
        input.budgetMax === undefined || input.budgetMax === null
          ? null
          : Money.parse(input.budgetMax, base).amountMinor,
      notifyMatches: input.notifyMatches ?? false,
      notes: input.notes ?? null,
    };
  }

  private async reach(
    actor: Principal,
    id: string,
    permission: PermissionKey,
    lock = false,
  ): Promise<Lead> {
    const { deps } = this;
    const lead = lock ? await deps.leads.lock(id) : await deps.leads.get(id);
    if (lead === null || !reachesLead(actor, deps.scope, permission, lead))
      throw new LeadNotFoundError();
    return lead;
  }

  private async detail(lead: Lead): Promise<LeadDetailView> {
    const { deps } = this;
    return {
      ...view(lead, await this.base()),
      activities: await deps.leads.activities(lead.id),
      tasks: await deps.leads.tasks(lead.id),
    };
  }

  private async log(
    actor: Principal,
    lead: Lead,
    kind: ActivityKind,
    note: string | null,
    details: LeadActivity["details"],
    at?: Date,
  ): Promise<void> {
    const { deps } = this;
    const now = deps.clock.now();
    await deps.leads.addActivity({
      id: deps.ids.next(),
      leadId: lead.id,
      kind,
      note,
      details,
      occurredAt: at ?? now,
      recordedBy: actor.userId,
      recordedAt: now,
    });
  }

  private async base(): Promise<string> {
    return (await this.deps.organisation.currencySettings()).baseCurrency;
  }

  private async audit(
    actor: Principal,
    action: string,
    lead: Lead,
    metadata?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const p = lead.snapshot();
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: "dealer_lead",
      entityId: lead.id,
      after: { number: p.number, stage: p.stage, assignedTo: p.assignedTo },
      ...(metadata === undefined ? {} : { metadata }),
    });
  }
}

function view(lead: Lead, base: string): LeadView {
  const { budgetMaxMinor, ...p } = lead.snapshot();
  return {
    ...p,
    budgetMax: budgetMaxMinor === null ? null : Money.ofMinor(budgetMaxMinor, base).toJSON(),
  };
}

function line(rows: readonly FunnelRow[]): FunnelLine {
  const count = (pred: (r: FunnelRow) => boolean) =>
    rows.filter(pred).reduce((s, r) => s + r.leads, 0);
  const leads = count(() => true);
  const won = count((r) => r.stage === "won");
  const lost = count((r) => r.stage === "lost");
  return { leads, open: leads - won - lost, won, lost, conversion: conversionRate(won, leads) };
}

function next(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
