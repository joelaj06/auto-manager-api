-- Billing automation (P4-3, docs/25 §5): the dunning policy, reminders sent, extensions, the
-- automation's runs and the dispute hold that stops automatic deactivation.

-- The schedule and safeguards, versioned: the latest row is in force.
create table dunning_policies (
  version     integer primary key check (version > 0),
  -- { invoiceLeadDays, reminderDaysBefore[], overdueReminderDays[], graceDays,
  --   readOnlyAfterDays|null, skipSundays, extension{maxDays, maxPer90Days, finalGraceDays},
  --   dryRun, circuitBreaker{maxCount, maxPercent}, reviewBranchThreshold,
  --   gatewayGuard{maxFailedWebhooks24h}, channels[] }
  policy      jsonb not null,
  created_by  uuid references platform_users (id),
  created_at  timestamptz not null default now()
);

-- Dry run on until staff turn it off (docs/25 §5.6: the first weeks after launch).
insert into dunning_policies (version, policy) values (1, '{
  "invoiceLeadDays": 7,
  "reminderDaysBefore": [7, 3, 1],
  "overdueReminderDays": [1, 3, 5],
  "graceDays": 7,
  "readOnlyAfterDays": null,
  "skipSundays": false,
  "extension": { "maxDays": 10, "maxPer90Days": 2, "finalGraceDays": 1 },
  "dryRun": true,
  "circuitBreaker": { "maxCount": 5, "maxPercent": 10 },
  "reviewBranchThreshold": 5,
  "gatewayGuard": { "maxFailedWebhooks24h": 5 },
  "channels": ["email", "sms", "in_app", "push"]
}');

-- Every billing notice sent (or tried), once per tenant, invoice, step, channel and recipient.
create table billing_notices (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references tenants (id),
  invoice_id  uuid references billing_invoices (id),
  -- reminder_7, due, overdue_1, final_notice, deactivated, restored, extension_approved …
  step        text not null check (step ~ '^[a-z][a-z0-9_]{1,40}$'),
  channel     text not null check (channel in ('email', 'sms', 'in_app', 'push')),
  recipient   text not null check (length(recipient) between 1 and 200),
  status      text not null check (status in ('sent', 'failed', 'skipped')),
  error       text check (length(error) <= 500),
  sent_at     timestamptz not null default now()
);

create unique index billing_notices_once_idx
  on billing_notices (tenant_id, coalesce(invoice_id, '00000000-0000-0000-0000-000000000000'::uuid),
                      step, channel, recipient);
create index billing_notices_tenant_idx on billing_notices (tenant_id, sent_at desc);

-- More time to pay an invoice, asked by the tenant and decided by staff.
create table billing_extensions (
  id               uuid primary key default uuidv7(),
  tenant_id        uuid not null references tenants (id),
  invoice_id       uuid not null references billing_invoices (id),
  requested_until  date not null,
  note             text check (length(note) <= 1000),
  status           text not null default 'requested'
                   check (status in ('requested', 'approved', 'denied', 'expired', 'closed')),
  approved_until   date,
  requested_by     uuid,
  decided_by       uuid references platform_users (id),
  decided_at       timestamptz,
  decision_reason  text check (length(decision_reason) <= 1000),
  created_at       timestamptz not null default now(),
  check (status not in ('approved', 'expired') or approved_until is not null),
  check (status = 'closed' or (status = 'requested') = (decided_at is null))
);

create index billing_extensions_tenant_idx on billing_extensions (tenant_id, created_at desc);
create index billing_extensions_status_idx on billing_extensions (status, created_at);
create unique index billing_extensions_open_idx on billing_extensions (invoice_id)
  where status in ('requested', 'approved');

-- Each run of the automation: what it did, what it would have done (dry run), why it stopped.
create table billing_automation_runs (
  id              uuid primary key default uuidv7(),
  run_on          date not null,
  dry_run         boolean not null,
  status          text not null check (status in ('completed', 'halted', 'failed')),
  halt_reason     text check (length(halt_reason) <= 500),
  invoices_issued integer not null default 0,
  notices_sent    integer not null default 0,
  charges_tried   integer not null default 0,
  past_due        integer not null default 0,
  deactivated     jsonb not null default '[]'::jsonb,
  would_deactivate jsonb not null default '[]'::jsonb,
  held_back       jsonb not null default '[]'::jsonb,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz
);

create index billing_automation_runs_idx on billing_automation_runs (started_at desc);

-- Dispute hold (billing dispute, pending refund): no automatic deactivation for the tenant.
alter table subscriptions
  add column dispute_hold boolean not null default false,
  add column dispute_hold_reason text check (length(dispute_hold_reason) <= 500),
  add check (dispute_hold = (dispute_hold_reason is not null));
