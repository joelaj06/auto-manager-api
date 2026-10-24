import type {
  AlertInput,
  AlertSeverity,
  AlertStatus,
  IPlatformAlertRepository,
  PlatformAlert,
} from "../../domain/repositories/IPlatformAlertRepository.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RANK: Readonly<Record<AlertSeverity, number>> = { info: 0, warning: 1, critical: 2 };

type Row = {
  id: string;
  key: string;
  severity: AlertSeverity;
  source: string;
  title: string;
  detail: Record<string, unknown>;
  tenant_id: string | null;
  runbook: string | null;
  status: AlertStatus;
  occurrences: number;
  first_seen_at: Date;
  last_seen_at: Date;
  acknowledged_by: string | null;
  acknowledged_at: Date | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  notified_at: Date | null;
};

const toAlert = (r: Row): PlatformAlert => ({
  id: r.id,
  key: r.key,
  severity: r.severity,
  source: r.source,
  title: r.title,
  detail: r.detail,
  tenantId: r.tenant_id,
  runbook: r.runbook,
  status: r.status,
  occurrences: r.occurrences,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
  acknowledgedBy: r.acknowledged_by,
  acknowledgedAt: r.acknowledged_at,
  resolvedBy: r.resolved_by,
  resolvedAt: r.resolved_at,
  notifiedAt: r.notified_at,
});

export class PostgresPlatformAlertRepository implements IPlatformAlertRepository {
  constructor(private readonly db: PlatformDb) {}

  async raise(input: AlertInput, now: Date) {
    const { rows: open } = await this.db.query<Row>(
      "select * from platform_alerts where key = $1 and status <> 'resolved' for update",
      [input.key],
    );
    const existing = open[0];
    if (existing !== undefined) {
      const escalated = RANK[input.severity] > RANK[existing.severity];
      const { rows } = await this.db.query<Row>(
        `update platform_alerts
            set occurrences = occurrences + 1, last_seen_at = $2,
                severity = case when $3 then $4 else severity end,
                detail = $5, status = case when $3 then 'open' else status end
          where id = $1 returning *`,
        [
          existing.id,
          now,
          escalated,
          input.severity,
          JSON.stringify(input.detail ?? existing.detail),
        ],
      );
      return { alert: toAlert(rows[0]!), escalated };
    }
    const { rows } = await this.db.query<Row>(
      `insert into platform_alerts (key, severity, source, title, detail, tenant_id, runbook,
         first_seen_at, last_seen_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $8) returning *`,
      [
        input.key,
        input.severity,
        input.source,
        input.title.slice(0, 200),
        JSON.stringify(input.detail ?? {}),
        input.tenantId ?? null,
        input.runbook ?? null,
        now,
      ],
    );
    return { alert: toAlert(rows[0]!), escalated: true };
  }

  async find(id: string, lock = false): Promise<PlatformAlert | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<Row>(
      `select * from platform_alerts where id = $1${lock ? " for update" : ""}`,
      [id],
    );
    return rows[0] === undefined ? null : toAlert(rows[0]);
  }

  async list(
    f: Readonly<{ status?: AlertStatus; severity?: AlertSeverity; source?: string; limit: number }>,
  ): Promise<PlatformAlert[]> {
    const { rows } = await this.db.query<Row>(
      `select * from platform_alerts
        where ($1::text is null or status = $1) and ($2::text is null or severity = $2)
          and ($3::text is null or source = $3)
        order by case severity when 'critical' then 0 when 'warning' then 1 else 2 end,
                 last_seen_at desc
        limit $4`,
      [f.status ?? null, f.severity ?? null, f.source ?? null, f.limit],
    );
    return rows.map(toAlert);
  }

  async acknowledge(id: string, staffId: string, now: Date): Promise<void> {
    await this.db.query(
      `update platform_alerts set status = 'acknowledged', acknowledged_by = $2, acknowledged_at = $3
        where id = $1 and status = 'open'`,
      [id, staffId, now],
    );
  }

  async resolve(id: string, staffId: string | null, now: Date): Promise<void> {
    await this.db.query(
      `update platform_alerts set status = 'resolved', resolved_by = $2, resolved_at = $3
        where id = $1 and status <> 'resolved'`,
      [id, staffId, now],
    );
  }

  async markNotified(id: string, now: Date): Promise<void> {
    await this.db.query("update platform_alerts set notified_at = $2 where id = $1", [id, now]);
  }

  async openCounts(): Promise<Readonly<Record<AlertSeverity, number>>> {
    const { rows } = await this.db.query<{ severity: AlertSeverity; n: number }>(
      `select severity, count(*)::int as n from platform_alerts
        where status <> 'resolved' group by severity`,
    );
    const counts = { info: 0, warning: 0, critical: 0 };
    for (const r of rows) counts[r.severity] = r.n;
    return counts;
  }
}
