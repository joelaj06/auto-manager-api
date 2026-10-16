-- Background jobs and notifications (P0-8). The job queue itself (pg-boss, schema `pgboss`) is
-- installed and upgraded by the migration command after these files run, and granted to
-- af_platform_rw there.

-- Business-day jobs run in the tenant's local time (doc 15 §3). Ghana is the default market.
alter table tenants
  add column timezone text not null default 'Africa/Accra'
  check (timezone ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$');

-- One row per (tenant, scheduled job, local date): the scheduler inserts the row and enqueues the
-- job in the same transaction, so each tenant job runs once per local day even when ticks repeat.
create table tenant_schedule_runs (
  tenant_id   uuid not null references tenants (id),
  job         text not null,
  local_date  date not null,
  enqueued_at timestamptz not null default now(),
  primary key (tenant_id, job, local_date)
);

create index tenant_schedule_runs_enqueued_idx on tenant_schedule_runs (enqueued_at);

-- Emails sent through the platform's own provider (doc 15: invitations, password reset, billing
-- notices). Rendered content is kept only until it is sent, because it may contain one-time
-- codes or links; the row then remains as the delivery record.
create table email_deliveries (
  id                  uuid primary key default uuidv7(),
  idempotency_key     text not null unique check (length(idempotency_key) between 1 and 200),
  tenant_id           uuid references tenants (id),
  template            text not null,
  recipient           text not null check (length(recipient) between 3 and 320),
  subject             text,
  body_text           text,
  body_html           text,
  status              text not null default 'queued'
                      check (status in ('queued', 'sent', 'failed')),
  attempts            integer not null default 0 check (attempts >= 0),
  provider_message_id text,
  last_error          text,
  created_at          timestamptz not null default now(),
  sent_at             timestamptz,
  check (status <> 'sent' or (sent_at is not null and body_text is null and body_html is null))
);

create index email_deliveries_tenant_idx on email_deliveries (tenant_id, created_at desc)
  where tenant_id is not null;
create index email_deliveries_status_idx on email_deliveries (status, created_at)
  where status <> 'sent';
