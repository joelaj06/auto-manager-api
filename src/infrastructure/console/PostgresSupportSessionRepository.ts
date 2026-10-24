import {
  SupportSession,
  type SupportSessionProps,
  type SupportStatus,
} from "../../domain/console/SupportSession.js";
import type {
  ISupportSessionRepository,
  LiveSupportSession,
  SupportRequestRecord,
  SupportSessionRow,
} from "../../domain/repositories/ISupportSessionRepository.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = {
  id: string;
  staff_id: string;
  staff_session_id: string;
  tenant_id: string;
  mode: SupportSessionProps["mode"];
  reason: string;
  ticket: string | null;
  status: SupportStatus;
  approval_id: string | null;
  approved_by: string | null;
  duration_minutes: number;
  requested_at: Date;
  started_at: Date | null;
  expires_at: Date | null;
  ended_at: Date | null;
  end_reason: SupportSessionProps["endReason"];
  request_count: number;
};

const toProps = (r: Row): SupportSessionProps => ({
  id: r.id,
  staffId: r.staff_id,
  staffSessionId: r.staff_session_id,
  tenantId: r.tenant_id,
  mode: r.mode,
  reason: r.reason,
  ticket: r.ticket,
  status: r.status,
  approvalId: r.approval_id,
  approvedBy: r.approved_by,
  durationMinutes: r.duration_minutes,
  requestedAt: r.requested_at,
  startedAt: r.started_at,
  expiresAt: r.expires_at,
  endedAt: r.ended_at,
  endReason: r.end_reason,
  requestCount: r.request_count,
});

export class PostgresSupportSessionRepository implements ISupportSessionRepository {
  constructor(private readonly db: PlatformDb) {}

  async save(session: SupportSession): Promise<void> {
    const s = session.snapshot();
    await this.db.query(
      `insert into support_sessions (id, staff_id, staff_session_id, tenant_id, mode, reason, ticket,
         status, approval_id, approved_by, duration_minutes, requested_at, started_at, expires_at,
         ended_at, end_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       on conflict (id) do update set status = excluded.status,
         approval_id = excluded.approval_id, approved_by = excluded.approved_by,
         duration_minutes = excluded.duration_minutes, started_at = excluded.started_at,
         expires_at = excluded.expires_at, ended_at = excluded.ended_at,
         end_reason = excluded.end_reason`,
      [
        s.id,
        s.staffId,
        s.staffSessionId,
        s.tenantId,
        s.mode,
        s.reason,
        s.ticket,
        s.status,
        s.approvalId,
        s.approvedBy,
        s.durationMinutes,
        s.requestedAt,
        s.startedAt,
        s.expiresAt,
        s.endedAt,
        s.endReason,
      ],
    );
  }

  async find(id: string, lock = false): Promise<SupportSession | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<Row>(
      `select * from support_sessions where id = $1${lock ? " for update" : ""}`,
      [id],
    );
    return rows[0] === undefined ? null : SupportSession.restore(toProps(rows[0]));
  }

  async live(id: string, now: Date): Promise<LiveSupportSession | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<{
      id: string;
      tenant_id: string;
      staff_id: string;
      staff_name: string;
      mode: LiveSupportSession["mode"];
      expires_at: Date;
    }>(
      `select s.id, s.tenant_id, s.staff_id, u.name as staff_name, s.mode, s.expires_at
         from support_sessions s
         join platform_users u on u.id = s.staff_id and u.status = 'active'
         join platform_sessions c on c.id = s.staff_session_id
        where s.id = $1 and s.status = 'active' and s.expires_at > $2
          and c.revoked_at is null and c.expires_at > $2`,
      [id, now],
    );
    const r = rows[0];
    return r === undefined
      ? null
      : {
          id: r.id,
          tenantId: r.tenant_id,
          staffId: r.staff_id,
          staffName: r.staff_name,
          mode: r.mode,
          expiresAt: r.expires_at,
        };
  }

  async list(
    f: Readonly<{
      staffId?: string;
      tenantId?: string;
      status?: SupportStatus;
      from?: Date;
      limit: number;
    }>,
  ): Promise<SupportSessionRow[]> {
    const { rows } = await this.db.query<Row & { staff_name: string; tenant_name: string }>(
      `select s.*, u.name as staff_name, t.name as tenant_name
         from support_sessions s
         join platform_users u on u.id = s.staff_id
         join tenants t on t.id = s.tenant_id
        where ($1::uuid is null or s.staff_id = $1) and ($2::uuid is null or s.tenant_id = $2)
          and ($3::text is null or s.status = $3)
          and ($4::timestamptz is null or s.requested_at >= $4)
        order by s.requested_at desc limit $5`,
      [f.staffId ?? null, f.tenantId ?? null, f.status ?? null, f.from ?? null, f.limit],
    );
    return rows.map((r) => ({ ...toProps(r), staffName: r.staff_name, tenantName: r.tenant_name }));
  }

  async recordRequest(sessionId: string, r: SupportRequestRecord): Promise<void> {
    await this.db.query(
      `with logged as (
         insert into support_session_requests (session_id, method, path, status_code, request_id, at)
         values ($1, $2, $3, $4, $5, $6) returning session_id)
       update support_sessions set request_count = request_count + 1
        where id = (select session_id from logged)`,
      [sessionId, r.method, r.path.slice(0, 500), r.statusCode, r.requestId, r.at],
    );
  }

  async requests(sessionId: string, limit: number): Promise<SupportRequestRecord[]> {
    const { rows } = await this.db.query<{
      method: string;
      path: string;
      status_code: number;
      request_id: string | null;
      at: Date;
    }>(
      `select method, path, status_code, request_id, at from support_session_requests
        where session_id = $1 order by at, id limit $2`,
      [sessionId, limit],
    );
    return rows.map((r) => ({
      method: r.method,
      path: r.path,
      statusCode: r.status_code,
      requestId: r.request_id,
      at: r.at,
    }));
  }

  async openedBy(staffId: string, since: Date): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      "select count(*)::int as n from support_sessions where staff_id = $1 and requested_at >= $2",
      [staffId, since],
    );
    return rows[0]!.n;
  }

  async logVisible(tenantId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ visible: boolean }>(
      "select support_log_visible as visible from tenants where id = $1",
      [tenantId],
    );
    return rows[0]?.visible ?? true;
  }

  async setLogVisible(tenantId: string, visible: boolean): Promise<void> {
    await this.db.query("update tenants set support_log_visible = $2 where id = $1", [
      tenantId,
      visible,
    ]);
  }
}
