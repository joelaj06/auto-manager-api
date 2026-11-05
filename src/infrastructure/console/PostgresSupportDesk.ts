import type { Paged } from "../../domain/value-objects/Paged.js";
import { pagedQuery } from "../database/postgres/PagedQuery.js";
import {
  SupportTicket,
  TICKET_PRIORITIES,
  type Escalation,
  type SlaTarget,
  type SlaTargets,
  type SupportTicketProps,
  type TicketCategory,
  type TicketPriority,
} from "../../domain/console/SupportDesk.js";
import type {
  CannedResponse,
  CannedResponseInput,
  ISupportDesk,
  NewTicketMessage,
  SupportSummary,
  TicketFilter,
  TicketMessage,
  TicketView,
} from "../../application/ports/ISupportDesk.js";
import type { Queryable } from "../database/postgres/Queryable.js";

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown) => (typeof v === "string" ? v : null);
const date = (v: unknown) => (v instanceof Date ? v : null);
const ACTIVE = `('open', 'waiting_on_customer', 'escalated')`;

function toProps(r: Row): SupportTicketProps {
  return {
    id: String(r.id),
    number: String(r.number),
    tenantId: text(r.tenant_id),
    tenantUserId: text(r.tenant_user_id),
    requesterName: String(r.requester_name),
    requesterEmail: text(r.requester_email),
    requesterPhone: text(r.requester_phone),
    channel: r.channel as SupportTicketProps["channel"],
    subject: String(r.subject),
    category: r.category as TicketCategory,
    priority: r.priority as TicketPriority,
    status: r.status as SupportTicketProps["status"],
    businessHours: r.business_hours === true,
    assigneeId: text(r.assignee_id),
    dataProtectionRequestId: text(r.data_protection_request_id),
    firstResponseDueAt: r.first_response_due_at as Date,
    resolutionDueAt: r.resolution_due_at as Date,
    firstRespondedAt: date(r.first_responded_at),
    firstResponseBreachedAt: date(r.first_response_breached_at),
    resolutionBreachedAt: date(r.resolution_breached_at),
    pausedAt: date(r.paused_at),
    escalation: (r.escalation ?? null) as Escalation | null,
    escalatedAt: date(r.escalated_at),
    resolvedAt: date(r.resolved_at),
    closedAt: date(r.closed_at),
    satisfaction: r.satisfaction === null ? null : Number(r.satisfaction),
    satisfactionComment: text(r.satisfaction_comment),
    ratedAt: date(r.rated_at),
    createdBy: text(r.created_by),
    createdAt: r.created_at as Date,
  };
}

const VIEW = `
  select k.*, t.slug::text as tenant_slug, t.name as tenant_name, u.name as assignee_name
    from support_tickets k
    left join tenants t on t.id = k.tenant_id
    left join platform_users u on u.id = k.assignee_id`;

const toView = (r: Row): TicketView => ({
  ...toProps(r),
  tenantSlug: text(r.tenant_slug),
  tenantName: text(r.tenant_name),
  assigneeName: text(r.assignee_name),
  updatedAt: r.updated_at as Date,
});

const toMessage = (r: Row): TicketMessage => ({
  id: String(r.id),
  ticketId: String(r.ticket_id),
  authorType: r.author_type as TicketMessage["authorType"],
  authorStaffId: text(r.author_staff_id),
  authorName: String(r.author_name),
  body: String(r.body),
  internal: r.internal === true,
  cannedResponseId: text(r.canned_response_id),
  createdAt: r.created_at as Date,
});

const toCanned = (r: Row): CannedResponse => ({
  id: String(r.id),
  title: String(r.title),
  body: String(r.body),
  category: (r.category ?? null) as TicketCategory | null,
  active: r.active === true,
  uses: Number(r.uses),
  createdBy: String(r.created_by),
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
});

/** The support desk tables of the platform database (platform migration 0026). */
export class PostgresSupportDesk implements ISupportDesk {
  constructor(private readonly db: Queryable) {}

  async nextNumber(year: number): Promise<string> {
    const { rows } = await this.db.query<{ value: string }>(
      `insert into counters (key, value) values ($1, 1)
       on conflict (key) do update set value = counters.value + 1, updated_at = now()
       returning value`,
      [`support_ticket:${year}`],
    );
    return `AF-SUP-${year}-${rows[0]!.value.padStart(6, "0")}`;
  }

  async insert(ticket: SupportTicket): Promise<void> {
    const t = ticket.snapshot();
    await this.db.query(
      `insert into support_tickets
         (id, number, tenant_id, tenant_user_id, requester_name, requester_email, requester_phone,
          channel, subject, category, priority, status, business_hours, first_response_due_at,
          resolution_due_at, created_by, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)`,
      [
        t.id,
        t.number,
        t.tenantId,
        t.tenantUserId,
        t.requesterName,
        t.requesterEmail,
        t.requesterPhone,
        t.channel,
        t.subject,
        t.category,
        t.priority,
        t.status,
        t.businessHours,
        t.firstResponseDueAt,
        t.resolutionDueAt,
        t.createdBy,
        t.createdAt,
      ],
    );
  }

  async lock(id: string): Promise<SupportTicket | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<Row>(
      "select * from support_tickets where id = $1 for update",
      [id],
    );
    return rows[0] === undefined ? null : SupportTicket.restore(toProps(rows[0]));
  }

  async save(ticket: SupportTicket): Promise<void> {
    const t = ticket.snapshot();
    await this.db.query(
      `update support_tickets
          set tenant_id = $2, category = $3, priority = $4, status = $5, business_hours = $6,
              assignee_id = $7, data_protection_request_id = $8, first_response_due_at = $9,
              resolution_due_at = $10, first_responded_at = $11, first_response_breached_at = $12,
              resolution_breached_at = $13, paused_at = $14, escalation = $15::jsonb,
              escalated_at = $16, resolved_at = $17, closed_at = $18, satisfaction = $19,
              satisfaction_comment = $20, rated_at = $21, updated_at = now()
        where id = $1`,
      [
        t.id,
        t.tenantId,
        t.category,
        t.priority,
        t.status,
        t.businessHours,
        t.assigneeId,
        t.dataProtectionRequestId,
        t.firstResponseDueAt,
        t.resolutionDueAt,
        t.firstRespondedAt,
        t.firstResponseBreachedAt,
        t.resolutionBreachedAt,
        t.pausedAt,
        t.escalation === null ? null : JSON.stringify(t.escalation),
        t.escalatedAt,
        t.resolvedAt,
        t.closedAt,
        t.satisfaction,
        t.satisfactionComment,
        t.ratedAt,
      ],
    );
  }

  async find(id: string): Promise<TicketView | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<Row>(`${VIEW} where k.id = $1`, [id]);
    return rows[0] === undefined ? null : toView(rows[0]);
  }

  async list(filter: TicketFilter): Promise<Paged<TicketView>> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (filter.status === "active") where.push(`k.status in ${ACTIVE}`);
    else if (filter.status !== undefined) add("k.status = ?", filter.status);
    if (filter.priority !== undefined) add("k.priority = ?", filter.priority);
    if (filter.category !== undefined) add("k.category = ?", filter.category);
    if (filter.tenantId !== undefined) add("k.tenant_id = ?", filter.tenantId);
    if (filter.tenantUserId !== undefined) add("k.tenant_user_id = ?", filter.tenantUserId);
    if (filter.assigneeId !== undefined) add("k.assignee_id = ?", filter.assigneeId);
    if (filter.breached === true)
      where.push(
        "(k.first_response_breached_at is not null or k.resolution_breached_at is not null)",
      );
    if (filter.q !== undefined && filter.q.trim() !== "") {
      params.push(`%${filter.q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
      const q = `$${params.length}`;
      where.push(
        `(k.number ilike ${q} or k.subject ilike ${q} or k.requester_name ilike ${q}
          or k.requester_email::text ilike ${q})`,
      );
    }
    const { rows, total } = await pagedQuery<Row>(
      this.db,
      {
        sql: `${VIEW} ${where.length === 0 ? "" : `where ${where.join(" and ")}`}`,
        orderBy: `(k.status in ${ACTIVE}) desc,
                case k.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
                k.resolution_due_at, k.created_at desc, k.id desc`,
        params,
      },
      filter,
    );
    return { rows: rows.map(toView), total };
  }

  async addMessage(message: NewTicketMessage): Promise<TicketMessage> {
    const { rows } = await this.db.query<Row>(
      `insert into support_ticket_messages
         (ticket_id, author_type, author_staff_id, author_name, body, internal, canned_response_id)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [
        message.ticketId,
        message.authorType,
        message.authorStaffId,
        message.authorName.slice(0, 120),
        message.body,
        message.internal,
        message.cannedResponseId,
      ],
    );
    await this.db.query("update support_tickets set updated_at = now() where id = $1", [
      message.ticketId,
    ]);
    return toMessage(rows[0]!);
  }

  async messages(ticketId: string, includeInternal: boolean): Promise<TicketMessage[]> {
    const { rows } = await this.db.query<Row>(
      `select * from support_ticket_messages
        where ticket_id = $1 ${includeInternal ? "" : "and not internal"}
        order by created_at, id`,
      [ticketId],
    );
    return rows.map(toMessage);
  }

  async sweepCandidates(now: Date, limit: number): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `select id from support_tickets
        where (status in ${ACTIVE}
               and ((first_responded_at is null and first_response_breached_at is null
                     and first_response_due_at < $1)
                    or (status <> 'waiting_on_customer' and resolution_breached_at is null
                        and resolution_due_at < $1)
                    or (status = 'waiting_on_customer' and paused_at <= $1 - interval '7 days')))
           or (status = 'resolved' and resolved_at <= $1 - interval '7 days')
        order by created_at
        limit $2`,
      [now, limit],
    );
    return rows.map((r) => r.id);
  }

  async summary(since: Date, now: Date): Promise<SupportSummary> {
    const { rows } = await this.db.query<Row>(
      `select
         count(*) filter (where status in ${ACTIVE})::int as active,
         count(*) filter (where status in ${ACTIVE} and assignee_id is null)::int as unassigned,
         count(*) filter (where status = 'escalated')::int as escalated,
         count(*) filter (where status = 'waiting_on_customer')::int as waiting,
         count(*) filter (where status in ${ACTIVE}
                          and (first_response_breached_at is not null
                               or resolution_breached_at is not null
                               or (first_responded_at is null and first_response_due_at < $1)
                               or (status <> 'waiting_on_customer' and resolution_due_at < $1)))::int
           as breached
       from support_tickets`,
      [now],
    );
    const { rows: byPriority } = await this.db.query<{ priority: TicketPriority; n: number }>(
      `select priority, count(*)::int as n from support_tickets where status in ${ACTIVE}
        group by priority`,
    );
    const { rows: period } = await this.db.query<Row>(
      `select
         count(*) filter (where created_at >= $1)::int as raised,
         count(*) filter (where resolved_at >= $1)::int as resolved,
         round(100.0 * count(*) filter (where created_at >= $1 and first_responded_at is not null
                                          and first_responded_at <= first_response_due_at)
               / nullif(count(*) filter (where created_at >= $1
                                           and (first_responded_at is not null
                                                or first_response_due_at < $2)), 0), 1)
           as first_met,
         round(100.0 * count(*) filter (where resolved_at >= $1 and resolution_breached_at is null)
               / nullif(count(*) filter (where resolved_at >= $1), 0), 1) as resolution_met,
         percentile_cont(0.5) within group (
           order by extract(epoch from first_responded_at - created_at) / 60)
           filter (where created_at >= $1 and first_responded_at is not null) as median_first,
         round(avg(satisfaction) filter (where rated_at >= $1), 2) as satisfaction,
         count(*) filter (where rated_at >= $1)::int as ratings
       from support_tickets`,
      [since, now],
    );
    const r = rows[0]!;
    const p = period[0]!;
    const counts = Object.fromEntries(TICKET_PRIORITIES.map((k) => [k, 0])) as Record<
      TicketPriority,
      number
    >;
    for (const row of byPriority) counts[row.priority] = row.n;
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return {
      active: Number(r.active),
      unassigned: Number(r.unassigned),
      escalated: Number(r.escalated),
      waitingOnCustomer: Number(r.waiting),
      breached: Number(r.breached),
      byPriority: counts,
      period: {
        raised: Number(p.raised),
        resolved: Number(p.resolved),
        firstResponseMetPercent: num(p.first_met),
        resolutionMetPercent: num(p.resolution_met),
        medianFirstResponseMinutes:
          p.median_first === null ? null : Math.round(Number(p.median_first)),
        satisfactionAverage: num(p.satisfaction),
        ratings: Number(p.ratings),
      },
    };
  }

  async slaTargets(): Promise<SlaTargets> {
    const { rows } = await this.db.query<Row>("select * from support_sla_targets");
    return Object.fromEntries(
      rows.map((r) => [
        r.priority,
        {
          priority: r.priority as TicketPriority,
          firstResponseMinutes: Number(r.first_response_minutes),
          resolutionMinutes: Number(r.resolution_minutes),
          businessHours: r.business_hours === true,
        },
      ]),
    ) as SlaTargets;
  }

  async setSlaTarget(target: SlaTarget, staffId: string): Promise<void> {
    await this.db.query(
      `update support_sla_targets
          set first_response_minutes = $2, resolution_minutes = $3, business_hours = $4,
              updated_at = now(), updated_by = $5
        where priority = $1`,
      [
        target.priority,
        target.firstResponseMinutes,
        target.resolutionMinutes,
        target.businessHours,
        staffId,
      ],
    );
  }

  async cannedResponses(activeOnly: boolean): Promise<CannedResponse[]> {
    const { rows } = await this.db.query<Row>(
      `select * from canned_responses ${activeOnly ? "where active" : ""}
        order by active desc, uses desc, title`,
    );
    return rows.map(toCanned);
  }

  async cannedResponse(id: string): Promise<CannedResponse | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<Row>("select * from canned_responses where id = $1", [id]);
    return rows[0] === undefined ? null : toCanned(rows[0]);
  }

  async createCanned(input: CannedResponseInput, staffId: string): Promise<CannedResponse> {
    const { rows } = await this.db.query<Row>(
      `insert into canned_responses (title, body, category, active, created_by)
       values ($1, $2, $3, $4, $5) returning *`,
      [input.title, input.body, input.category, input.active, staffId],
    );
    return toCanned(rows[0]!);
  }

  async updateCanned(
    id: string,
    input: CannedResponseInput,
    staffId: string,
  ): Promise<CannedResponse | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<Row>(
      `update canned_responses
          set title = $2, body = $3, category = $4, active = $5, updated_by = $6, updated_at = now()
        where id = $1 returning *`,
      [id, input.title, input.body, input.category, input.active, staffId],
    );
    return rows[0] === undefined ? null : toCanned(rows[0]);
  }

  async cannedUsed(id: string): Promise<void> {
    await this.db.query("update canned_responses set uses = uses + 1 where id = $1", [id]);
  }

  async staffName(staffId: string): Promise<string | null> {
    if (!UUID.test(staffId)) return null;
    const { rows } = await this.db.query<{ name: string }>(
      "select name from platform_users where id = $1",
      [staffId],
    );
    return rows[0]?.name ?? null;
  }

  async tenantName(tenantId: string): Promise<string | null> {
    if (!UUID.test(tenantId)) return null;
    const { rows } = await this.db.query<{ name: string }>(
      "select name from tenants where id = $1",
      [tenantId],
    );
    return rows[0]?.name ?? null;
  }

  async requestExists(requestId: string): Promise<boolean> {
    if (!UUID.test(requestId)) return false;
    const { rowCount } = await this.db.query(
      "select 1 from data_protection_requests where id = $1",
      [requestId],
    );
    return (rowCount ?? 0) > 0;
  }
}
