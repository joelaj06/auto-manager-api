import {
  TenantLifecycle,
  type DeactivationReason,
  type StatusTransition,
  type TenantLifecycleStatus,
} from "../../domain/entities/TenantLifecycle.js";
import type {
  ITenantLifecycleRepository,
  StatusHistoryEntry,
} from "../../domain/repositories/ITenantLifecycleRepository.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PostgresTenantLifecycleRepository implements ITenantLifecycleRepository {
  constructor(private readonly db: PlatformDb) {}

  async lockById(id: string): Promise<TenantLifecycle | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<{
      id: string;
      slug: string;
      name: string;
      status: TenantLifecycleStatus;
      previous_status: TenantLifecycleStatus | null;
      deactivation_reason: DeactivationReason | null;
      status_message: string | null;
      auto_restore_locked: boolean;
      status_changed_at: Date | null;
    }>(
      `select id, slug::text as slug, name, status, previous_status, deactivation_reason,
              status_message, auto_restore_locked, status_changed_at
         from tenants where id = $1 for update`,
      [id],
    );
    const r = rows[0];
    if (r === undefined) return null;
    return TenantLifecycle.restore({
      id: r.id,
      slug: r.slug,
      name: r.name,
      status: r.status,
      previousStatus: r.previous_status,
      deactivationReason: r.deactivation_reason,
      statusMessage: r.status_message,
      autoRestoreLocked: r.auto_restore_locked,
      statusChangedAt: r.status_changed_at,
    });
  }

  async save(tenant: TenantLifecycle): Promise<void> {
    const s = tenant.snapshot();
    await this.db.query(
      `update tenants set status = $2, previous_status = $3, deactivation_reason = $4,
              status_message = $5, auto_restore_locked = $6, status_changed_at = $7,
              updated_at = now(), version = version + 1
        where id = $1`,
      [
        s.id,
        s.status,
        s.previousStatus,
        s.deactivationReason,
        s.statusMessage,
        s.autoRestoreLocked,
        s.statusChangedAt,
      ],
    );
  }

  async appendHistory(entry: {
    tenantId: string;
    transition: StatusTransition;
    reason: string | null;
    actorType: "platform_staff" | "system";
    actorId: string | null;
  }): Promise<void> {
    const t = entry.transition;
    await this.db.query(
      `insert into tenant_status_history
         (tenant_id, from_status, to_status, reason_category, reason, message, actor_type, actor_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.tenantId,
        t.from,
        t.to,
        t.reasonCategory,
        entry.reason,
        t.message,
        entry.actorType,
        entry.actorId,
      ],
    );
  }

  async history(tenantId: string): Promise<StatusHistoryEntry[]> {
    if (!UUID.test(tenantId)) return [];
    const { rows } = await this.db.query<{
      id: string;
      from_status: TenantLifecycleStatus;
      to_status: TenantLifecycleStatus;
      reason_category: string | null;
      reason: string | null;
      message: string | null;
      actor_type: StatusHistoryEntry["actorType"];
      actor_id: string | null;
      created_at: Date;
    }>("select * from tenant_status_history where tenant_id = $1 order by id desc", [tenantId]);
    return rows.map((r) => ({
      id: r.id,
      fromStatus: r.from_status,
      toStatus: r.to_status,
      reasonCategory: r.reason_category,
      reason: r.reason,
      message: r.message,
      actorType: r.actor_type,
      actorId: r.actor_id,
      createdAt: r.created_at,
    }));
  }
}
