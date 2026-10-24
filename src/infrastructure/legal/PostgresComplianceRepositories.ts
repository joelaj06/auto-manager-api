import type {
  DataProtectionRequest,
  DrillKind,
  DprStatus,
  IDataProtectionRequestRepository,
  IIncidentRepository,
  Incident,
  IncidentUpdate,
  IRestoreDrillRepository,
  RestoreDrill,
} from "../../domain/repositories/IComplianceRepositories.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DprRow = {
  id: string;
  code: string;
  kind: DataProtectionRequest["kind"];
  tenant_id: string | null;
  requester_name: string;
  requester_contact: string;
  subject: string;
  received_at: Date;
  due_at: Date;
  status: DprStatus;
  assigned_to: string | null;
  steps: { at: string; by: string; note: string }[];
  outcome: string | null;
  closed_at: Date | null;
  created_by: string;
  created_at: Date;
};

const toDpr = (r: DprRow): DataProtectionRequest => ({
  id: r.id,
  code: r.code,
  kind: r.kind,
  tenantId: r.tenant_id,
  requesterName: r.requester_name,
  requesterContact: r.requester_contact,
  subject: r.subject,
  receivedAt: r.received_at,
  dueAt: r.due_at,
  status: r.status,
  assignedTo: r.assigned_to,
  steps: r.steps.map((s) => ({ at: new Date(s.at), by: s.by, note: s.note })),
  outcome: r.outcome,
  closedAt: r.closed_at,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

export class PostgresDataProtectionRequestRepository implements IDataProtectionRequestRepository {
  constructor(private readonly db: PlatformDb) {}

  async nextCode(year: number): Promise<string> {
    const { rows } = await this.db.query<{ value: string }>(
      `insert into counters (key, value) values ($1, 1)
       on conflict (key) do update set value = counters.value + 1, updated_at = now()
       returning value`,
      [`dpr:${year}`],
    );
    return `DPR-${year}-${rows[0]!.value.padStart(4, "0")}`;
  }

  async save(d: DataProtectionRequest): Promise<void> {
    await this.db.query(
      `insert into data_protection_requests (id, code, kind, tenant_id, requester_name,
         requester_contact, subject, received_at, due_at, status, assigned_to, steps, outcome,
         closed_at, created_by, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       on conflict (id) do update set due_at = excluded.due_at, status = excluded.status,
         assigned_to = excluded.assigned_to, steps = excluded.steps, outcome = excluded.outcome,
         closed_at = excluded.closed_at`,
      [
        d.id,
        d.code,
        d.kind,
        d.tenantId,
        d.requesterName,
        d.requesterContact,
        d.subject,
        d.receivedAt,
        d.dueAt,
        d.status,
        d.assignedTo,
        JSON.stringify(d.steps),
        d.outcome,
        d.closedAt,
        d.createdBy,
        d.createdAt,
      ],
    );
  }

  async find(id: string, lock = false): Promise<DataProtectionRequest | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<DprRow>(
      `select * from data_protection_requests where id = $1${lock ? " for update" : ""}`,
      [id],
    );
    return rows[0] === undefined ? null : toDpr(rows[0]);
  }

  async list(
    f: Readonly<{ status?: DprStatus; openOnly?: boolean; limit: number }>,
  ): Promise<DataProtectionRequest[]> {
    const { rows } = await this.db.query<DprRow>(
      `select * from data_protection_requests
        where ($1::text is null or status = $1)
          and (not $2 or status in ('open', 'in_progress'))
        order by case when status in ('open', 'in_progress') then 0 else 1 end, due_at
        limit $3`,
      [f.status ?? null, f.openOnly === true, f.limit],
    );
    return rows.map(toDpr);
  }

  async dueBefore(before: Date): Promise<DataProtectionRequest[]> {
    const { rows } = await this.db.query<DprRow>(
      `select * from data_protection_requests
        where status in ('open', 'in_progress') and due_at < $1 order by due_at`,
      [before],
    );
    return rows.map(toDpr);
  }
}

type IncidentRow = {
  id: string;
  title: string;
  impact: Incident["impact"];
  status: Incident["status"];
  components: string[];
  started_at: Date;
  resolved_at: Date | null;
  created_by: string;
  updates: { status: Incident["status"]; message: string; posted_at: string }[] | null;
};

const INCIDENT_SELECT = `select i.*, (select json_agg(json_build_object('status', u.status,
    'message', u.message, 'posted_at', u.posted_at) order by u.posted_at desc)
    from incident_updates u where u.incident_id = i.id) as updates
  from incidents i`;

const toIncident = (r: IncidentRow): Incident => ({
  id: r.id,
  title: r.title,
  impact: r.impact,
  status: r.status,
  components: r.components,
  startedAt: r.started_at,
  resolvedAt: r.resolved_at,
  createdBy: r.created_by,
  updates: (r.updates ?? []).map((u) => ({
    status: u.status,
    message: u.message,
    postedAt: new Date(u.posted_at),
  })),
});

export class PostgresIncidentRepository implements IIncidentRepository {
  constructor(private readonly db: PlatformDb) {}

  async save(i: Omit<Incident, "updates">): Promise<void> {
    await this.db.query(
      `insert into incidents (id, title, impact, status, components, started_at, resolved_at,
         created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (id) do update set title = excluded.title, impact = excluded.impact,
         status = excluded.status, components = excluded.components,
         resolved_at = excluded.resolved_at`,
      [i.id, i.title, i.impact, i.status, i.components, i.startedAt, i.resolvedAt, i.createdBy],
    );
  }

  async addUpdate(incidentId: string, u: IncidentUpdate, postedBy: string): Promise<void> {
    await this.db.query(
      `insert into incident_updates (incident_id, status, message, posted_by, posted_at)
       values ($1, $2, $3, $4, $5)`,
      [incidentId, u.status, u.message, postedBy, u.postedAt],
    );
  }

  async find(id: string, lock = false): Promise<Incident | null> {
    if (!UUID.test(id)) return null;
    if (lock) await this.db.query("select 1 from incidents where id = $1 for update", [id]);
    const { rows } = await this.db.query<IncidentRow>(`${INCIDENT_SELECT} where i.id = $1`, [id]);
    return rows[0] === undefined ? null : toIncident(rows[0]);
  }

  async recent(since: Date, limit: number): Promise<Incident[]> {
    const { rows } = await this.db.query<IncidentRow>(
      `${INCIDENT_SELECT} where i.resolved_at is null or i.resolved_at >= $1
        order by i.started_at desc limit $2`,
      [since, limit],
    );
    return rows.map(toIncident);
  }
}

type DrillRow = {
  id: string;
  kind: DrillKind;
  due_on: string;
  status: RestoreDrill["status"];
  performed_at: Date | null;
  performed_by: string | null;
  outcome: RestoreDrill["outcome"];
  rto_minutes: number | null;
  rpo_minutes: number | null;
  notes: string | null;
  created_at: Date;
};

const toDrill = (r: DrillRow): RestoreDrill => ({
  id: r.id,
  kind: r.kind,
  dueOn: r.due_on,
  status: r.status,
  performedAt: r.performed_at,
  performedBy: r.performed_by,
  outcome: r.outcome,
  rtoMinutes: r.rto_minutes,
  rpoMinutes: r.rpo_minutes,
  notes: r.notes,
  createdAt: r.created_at,
});

const DRILL_COLUMNS = `id, kind, due_on::text, status, performed_at, performed_by, outcome,
  rto_minutes, rpo_minutes, notes, created_at`;

export class PostgresRestoreDrillRepository implements IRestoreDrillRepository {
  constructor(private readonly db: PlatformDb) {}

  async save(d: RestoreDrill): Promise<void> {
    await this.db.query(
      `insert into restore_drills (id, kind, due_on, status, performed_at, performed_by, outcome,
         rto_minutes, rpo_minutes, notes, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (id) do update set due_on = excluded.due_on, status = excluded.status,
         performed_at = excluded.performed_at, performed_by = excluded.performed_by,
         outcome = excluded.outcome, rto_minutes = excluded.rto_minutes,
         rpo_minutes = excluded.rpo_minutes, notes = excluded.notes`,
      [
        d.id,
        d.kind,
        d.dueOn,
        d.status,
        d.performedAt,
        d.performedBy,
        d.outcome,
        d.rtoMinutes,
        d.rpoMinutes,
        d.notes,
        d.createdAt,
      ],
    );
  }

  async find(id: string, lock = false): Promise<RestoreDrill | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<DrillRow>(
      `select ${DRILL_COLUMNS} from restore_drills where id = $1${lock ? " for update" : ""}`,
      [id],
    );
    return rows[0] === undefined ? null : toDrill(rows[0]);
  }

  async scheduled(kind: DrillKind): Promise<RestoreDrill | null> {
    const { rows } = await this.db.query<DrillRow>(
      `select ${DRILL_COLUMNS} from restore_drills where kind = $1 and status = 'scheduled'`,
      [kind],
    );
    return rows[0] === undefined ? null : toDrill(rows[0]);
  }

  async list(limit: number): Promise<RestoreDrill[]> {
    const { rows } = await this.db.query<DrillRow>(
      `select ${DRILL_COLUMNS} from restore_drills order by due_on desc limit $1`,
      [limit],
    );
    return rows.map(toDrill);
  }
}
