-- Tenant lifecycle (P1-4, docs/27 §3.3): deactivation with reasons and tenant-facing messages,
-- restore to the previous status, read-only, and an append-only status history.

alter table tenants
  add column deactivation_reason   text check (deactivation_reason in (
                                       'non_payment', 'trial_expired', 'requested_pause', 'abuse',
                                       'legal', 'other')),
  -- Shown to the tenant's users (blocking screen, public tenant-config).
  add column status_message        text check (length(status_message) <= 500),
  -- Where a restore returns the tenant to.
  add column previous_status       text,
  -- Manual deactivations are never undone by billing automation (docs/25 §5.5).
  add column auto_restore_locked   boolean not null default false,
  add column status_changed_at     timestamptz;

create table tenant_status_history (
  id              uuid primary key default uuidv7(),
  tenant_id       uuid not null references tenants (id),
  from_status     text not null,
  to_status       text not null,
  reason_category text,
  -- Internal reason (staff only).
  reason          text,
  -- Message shown to the tenant.
  message         text,
  actor_type      text not null check (actor_type in ('platform_staff', 'system')),
  actor_id        uuid,
  approval_id     uuid,
  created_at      timestamptz not null default now()
);

create index tenant_status_history_tenant_idx on tenant_status_history (tenant_id, created_at desc);

revoke update, delete, truncate on tenant_status_history from af_platform_rw;
create trigger tenant_status_history_append_only
  before update or delete on tenant_status_history
  for each row execute function forbid_mutation();
