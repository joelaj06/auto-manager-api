import type {
  Announcement,
  AnnouncementAudience,
  AnnouncementStatus,
  ICommunicationsRepository,
  MaintenanceWindow,
} from "../../domain/repositories/ICommunicationsRepository.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AnnouncementRow = {
  id: string;
  title: string;
  body: string;
  severity: Announcement["severity"];
  audience: AnnouncementAudience;
  email: boolean;
  starts_at: Date;
  ends_at: Date;
  status: AnnouncementStatus;
  approval_id: string | null;
  emailed_at: Date | null;
  created_by: string;
  created_at: Date;
  published_at: Date | null;
};

type WindowRow = {
  id: string;
  title: string;
  message: string;
  starts_at: Date;
  ends_at: Date;
  read_only: boolean;
  status: MaintenanceWindow["status"];
  created_by: string;
  created_at: Date;
  cancelled_at: Date | null;
};

const toAnnouncement = (r: AnnouncementRow): Announcement => ({
  id: r.id,
  title: r.title,
  body: r.body,
  severity: r.severity,
  audience: r.audience,
  email: r.email,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  status: r.status,
  approvalId: r.approval_id,
  emailedAt: r.emailed_at,
  createdBy: r.created_by,
  createdAt: r.created_at,
  publishedAt: r.published_at,
});

const toWindow = (r: WindowRow): MaintenanceWindow => ({
  id: r.id,
  title: r.title,
  message: r.message,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  readOnly: r.read_only,
  status: r.status,
  createdBy: r.created_by,
  createdAt: r.created_at,
  cancelledAt: r.cancelled_at,
});

/** Whether tenant `t` (with subscription `s`) is in the audience `$a`. */
const IN_AUDIENCE = `
  (not ($a ? 'statuses') or t.status = any (array(select jsonb_array_elements_text($a -> 'statuses'))))
  and (not ($a ? 'licenceTypes')
       or s.licence_type = any (array(select jsonb_array_elements_text($a -> 'licenceTypes'))))
  and (not ($a ? 'tenantIds')
       or t.id::text = any (array(select jsonb_array_elements_text($a -> 'tenantIds'))))`;

export class PostgresCommunicationsRepository implements ICommunicationsRepository {
  constructor(private readonly db: PlatformDb) {}

  async saveAnnouncement(a: Announcement): Promise<void> {
    await this.db.query(
      `insert into announcements (id, title, body, severity, audience, email, starts_at, ends_at,
         status, approval_id, emailed_at, created_by, created_at, published_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       on conflict (id) do update set title = excluded.title, body = excluded.body,
         severity = excluded.severity, audience = excluded.audience, email = excluded.email,
         starts_at = excluded.starts_at, ends_at = excluded.ends_at, status = excluded.status,
         approval_id = excluded.approval_id, emailed_at = excluded.emailed_at,
         published_at = excluded.published_at`,
      [
        a.id,
        a.title,
        a.body,
        a.severity,
        JSON.stringify(a.audience),
        a.email,
        a.startsAt,
        a.endsAt,
        a.status,
        a.approvalId,
        a.emailedAt,
        a.createdBy,
        a.createdAt,
        a.publishedAt,
      ],
    );
  }

  async announcement(id: string, lock = false): Promise<Announcement | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<AnnouncementRow>(
      `select * from announcements where id = $1${lock ? " for update" : ""}`,
      [id],
    );
    return rows[0] === undefined ? null : toAnnouncement(rows[0]);
  }

  async announcements(
    f: Readonly<{ status?: AnnouncementStatus; limit: number }>,
  ): Promise<Announcement[]> {
    const { rows } = await this.db.query<AnnouncementRow>(
      `select * from announcements where ($1::text is null or status = $1)
        order by created_at desc limit $2`,
      [f.status ?? null, f.limit],
    );
    return rows.map(toAnnouncement);
  }

  async liveFor(tenantId: string, userId: string, now: Date) {
    const { rows } = await this.db.query<AnnouncementRow & { read: boolean }>(
      `select a.*, exists (select 1 from announcement_reads r
                            where r.announcement_id = a.id and r.tenant_id = $1
                              and r.user_id = $2) as read
         from announcements a
         join tenants t on t.id = $1
         left join subscriptions s on s.tenant_id = t.id
        where a.status = 'published' and a.starts_at <= $3 and a.ends_at > $3
          and ${IN_AUDIENCE.replaceAll("$a", "a.audience")}
        order by case a.severity when 'critical' then 0 when 'warning' then 1 else 2 end,
                 a.starts_at desc`,
      [tenantId, userId, now],
    );
    return rows.map((r) => ({ ...toAnnouncement(r), read: r.read }));
  }

  async audienceTenants(audience: AnnouncementAudience): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `select t.id from tenants t left join subscriptions s on s.tenant_id = t.id
        where t.status not in ('archived', 'provisioning', 'provisioning_failed')
          and ${IN_AUDIENCE.replaceAll("$a", "$1::jsonb")}
        order by t.id`,
      [JSON.stringify(audience)],
    );
    return rows.map((r) => r.id);
  }

  async markRead(announcementId: string, tenantId: string, userId: string): Promise<void> {
    await this.db.query(
      `insert into announcement_reads (announcement_id, tenant_id, user_id) values ($1, $2, $3)
       on conflict do nothing`,
      [announcementId, tenantId, userId],
    );
  }

  async readStats(announcementId: string) {
    const { rows } = await this.db.query<{ tenants: number; users: number }>(
      `select count(distinct tenant_id)::int as tenants, count(*)::int as users
         from announcement_reads where announcement_id = $1`,
      [announcementId],
    );
    return rows[0]!;
  }

  async markEmailed(announcementId: string, now: Date): Promise<void> {
    await this.db.query("update announcements set emailed_at = $2 where id = $1", [
      announcementId,
      now,
    ]);
  }

  async saveWindow(w: MaintenanceWindow): Promise<void> {
    await this.db.query(
      `insert into maintenance_windows (id, title, message, starts_at, ends_at, read_only, status,
         created_by, created_at, cancelled_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (id) do update set status = excluded.status, cancelled_at = excluded.cancelled_at`,
      [
        w.id,
        w.title,
        w.message,
        w.startsAt,
        w.endsAt,
        w.readOnly,
        w.status,
        w.createdBy,
        w.createdAt,
        w.cancelledAt,
      ],
    );
  }

  async window(id: string, lock = false): Promise<MaintenanceWindow | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<WindowRow>(
      `select * from maintenance_windows where id = $1${lock ? " for update" : ""}`,
      [id],
    );
    return rows[0] === undefined ? null : toWindow(rows[0]);
  }

  async windows(f: Readonly<{ from?: Date; limit: number }>): Promise<MaintenanceWindow[]> {
    const { rows } = await this.db.query<WindowRow>(
      `select * from maintenance_windows where ($1::timestamptz is null or ends_at >= $1)
        order by starts_at desc limit $2`,
      [f.from ?? null, f.limit],
    );
    return rows.map(toWindow);
  }

  async upcoming(now: Date, until: Date): Promise<MaintenanceWindow[]> {
    const { rows } = await this.db.query<WindowRow>(
      `select * from maintenance_windows
        where status = 'scheduled' and ends_at > $1 and starts_at < $2
        order by starts_at`,
      [now, until],
    );
    return rows.map(toWindow);
  }
}
