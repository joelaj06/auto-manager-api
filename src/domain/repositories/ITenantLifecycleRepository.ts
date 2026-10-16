import type {
  StatusTransition,
  TenantLifecycle,
  TenantLifecycleStatus,
} from "../entities/TenantLifecycle.js";

export type StatusHistoryEntry = Readonly<{
  id: string;
  fromStatus: TenantLifecycleStatus;
  toStatus: TenantLifecycleStatus;
  reasonCategory: string | null;
  reason: string | null;
  message: string | null;
  actorType: "platform_staff" | "system";
  actorId: string | null;
  createdAt: Date;
}>;

/** Tenant status and its append-only history (platform database). */
export interface ITenantLifecycleRepository {
  lockById(id: string): Promise<TenantLifecycle | null>;
  save(tenant: TenantLifecycle): Promise<void>;
  appendHistory(entry: {
    tenantId: string;
    transition: StatusTransition;
    reason: string | null;
    actorType: "platform_staff" | "system";
    actorId: string | null;
  }): Promise<void>;
  history(tenantId: string): Promise<StatusHistoryEntry[]>;
}
