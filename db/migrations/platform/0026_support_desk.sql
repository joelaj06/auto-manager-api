-- Support desk (P9-3, docs/27 §3.13, §5): tickets with their messages and SLA timers, canned
-- responses and the SLA targets per priority; demo and sandbox tenants that expire; the
-- onboarding concierge's task list for staff per new tenant.

-- How long staff have to answer and to resolve, per priority (docs/35 §2): in support hours
-- (Monday–Saturday 08:00–18:00 Accra) or, for urgent tickets, around the clock.
create table support_sla_targets (
  priority                text primary key check (priority in ('low', 'normal', 'high', 'urgent')),
  first_response_minutes  integer not null check (first_response_minutes between 5 and 20160),
  resolution_minutes      integer not null check (resolution_minutes between 15 and 86400),
  business_hours          boolean not null default true,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references platform_users (id),
  check (resolution_minutes >= first_response_minutes)
);
insert into support_sla_targets (priority, first_response_minutes, resolution_minutes, business_hours)
values ('urgent', 30, 480, false), ('high', 120, 600, true), ('normal', 600, 3000, true),
       ('low', 1200, 6000, true);

-- Replies staff reuse; {{requesterName}}, {{ticketNumber}}, {{staffName}}, {{businessName}}.
create table canned_responses (
  id          uuid primary key default uuidv7(),
  title       citext not null unique check (length(trim(title)) between 3 and 120),
  body        text not null check (length(trim(body)) between 1 and 5000),
  category    text check (category in ('how_to', 'technical', 'billing', 'data', 'account',
                                       'feature_request', 'other')),
  active      boolean not null default true,
  uses        integer not null default 0 check (uses >= 0),
  created_by  uuid not null references platform_users (id),
  updated_by  uuid references platform_users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table support_tickets (
  id                          uuid primary key default uuidv7(),
  number                      text not null unique,
  tenant_id                   uuid references tenants (id),
  -- The user in the tenant who raised it (their database, so no foreign key).
  tenant_user_id              uuid,
  requester_name              text not null check (length(trim(requester_name)) between 1 and 120),
  requester_email             citext check (requester_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  requester_phone             text check (requester_phone ~ '^\+[1-9][0-9]{7,14}$'),
  channel                     text not null
                              check (channel in ('app', 'email', 'phone', 'whatsapp', 'console')),
  subject                     text not null check (length(trim(subject)) between 3 and 200),
  category                    text not null
                              check (category in ('how_to', 'technical', 'billing', 'data',
                                                  'account', 'feature_request', 'other')),
  priority                    text not null default 'normal'
                              check (priority in ('low', 'normal', 'high', 'urgent')),
  status                      text not null default 'open'
                              check (status in ('open', 'waiting_on_customer', 'escalated',
                                                'resolved', 'closed')),
  assignee_id                 uuid references platform_users (id),
  data_protection_request_id  uuid references data_protection_requests (id),
  -- The targets count support hours only (copied from the priority's target).
  business_hours              boolean not null,
  first_response_due_at       timestamptz not null,
  resolution_due_at           timestamptz not null,
  first_responded_at          timestamptz,
  first_response_breached_at  timestamptz,
  resolution_breached_at      timestamptz,
  -- Waiting on the customer: the resolution clock stops and starts again on their reply.
  paused_at                   timestamptz,
  -- To engineering: { requestId, sentryUrl, note, by, at }.
  escalation                  jsonb,
  escalated_at                timestamptz,
  resolved_at                 timestamptz,
  closed_at                   timestamptz,
  satisfaction                smallint check (satisfaction between 1 and 5),
  satisfaction_comment        text check (length(satisfaction_comment) <= 1000),
  rated_at                    timestamptz,
  -- The staff member who logged it (null: raised in the app).
  created_by                  uuid references platform_users (id),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  check (tenant_user_id is null or tenant_id is not null),
  check (requester_email is not null or requester_phone is not null or tenant_user_id is not null),
  check ((status in ('resolved', 'closed')) = (resolved_at is not null)),
  check ((status = 'closed') = (closed_at is not null)),
  check ((status = 'waiting_on_customer') = (paused_at is not null)),
  check ((satisfaction is null) = (rated_at is null))
);

create index support_tickets_open_idx on support_tickets (priority, resolution_due_at)
  where status in ('open', 'waiting_on_customer', 'escalated');
create index support_tickets_resolved_idx on support_tickets (resolved_at) where status = 'resolved';
create index support_tickets_tenant_idx on support_tickets (tenant_id, created_at desc);
create index support_tickets_requester_idx on support_tickets (tenant_id, tenant_user_id, created_at desc)
  where tenant_user_id is not null;
create index support_tickets_assignee_idx on support_tickets (assignee_id)
  where assignee_id is not null;
create index support_tickets_dsr_idx on support_tickets (data_protection_request_id)
  where data_protection_request_id is not null;

-- The conversation: replies to the customer and internal notes (never shown to them).
create table support_ticket_messages (
  id                   uuid primary key default uuidv7(),
  ticket_id            uuid not null references support_tickets (id),
  author_type          text not null check (author_type in ('staff', 'customer', 'system')),
  author_staff_id      uuid references platform_users (id),
  author_name          text not null check (length(author_name) between 1 and 120),
  body                 text not null check (length(trim(body)) between 1 and 10000),
  internal             boolean not null default false,
  canned_response_id   uuid references canned_responses (id),
  created_at           timestamptz not null default now(),
  check ((author_type = 'staff') = (author_staff_id is not null)),
  check (not internal or author_type <> 'customer')
);

create index support_ticket_messages_ticket_idx on support_ticket_messages (ticket_id, created_at);
create index support_ticket_messages_staff_idx on support_ticket_messages (author_staff_id)
  where author_staff_id is not null;
create index support_ticket_messages_canned_idx on support_ticket_messages (canned_response_id)
  where canned_response_id is not null;

revoke update, delete, truncate on support_ticket_messages from af_platform_rw;
create trigger support_ticket_messages_append_only
  before update or delete on support_ticket_messages
  for each row execute function forbid_mutation();

-- Demo and sandbox tenants: sample data, never billed or counted, expired and then purged.
alter table tenants add column demo boolean not null default false;

create table demo_tenants (
  tenant_id       uuid primary key references tenants (id),
  purpose         text not null check (purpose in ('sales_demo', 'training')),
  prospect        text check (length(prospect) <= 200),
  sample_data     text not null default 'pending'
                  check (sample_data in ('pending', 'seeding', 'seeded', 'failed', 'none')),
  sample_report   jsonb not null default '{}'::jsonb,
  sample_error    text,
  expires_at      timestamptz not null,
  extensions      integer not null default 0 check (extensions >= 0),
  expired_at      timestamptz,
  purged_at       timestamptz,
  created_by      uuid not null references platform_users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (purged_at is null or expired_at is not null)
);

create index demo_tenants_live_idx on demo_tenants (expires_at) where purged_at is null;

-- The onboarding concierge: tasks for staff per new tenant, from these templates.
create table onboarding_task_templates (
  key              text primary key check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  title            text not null check (length(trim(title)) between 3 and 160),
  description      text check (length(description) <= 1000),
  due_after_hours  integer not null check (due_after_hours between 1 and 2160),
  -- The onboarding milestone (tenant_onboarding.steps) that completes the task by itself.
  completes_with   text check (completes_with in ('branch_added', 'vehicle_added', 'driver_added',
                                                  'user_invited', 'first_remittance', 'first_rental',
                                                  'first_transaction', 'app_installed')),
  position         integer not null default 0,
  active           boolean not null default true,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references platform_users (id)
);
insert into onboarding_task_templates (key, title, description, due_after_hours, completes_with, position)
values
  ('welcome_call', 'Call the owner to welcome them',
   'Introduce yourself, confirm what the business does and agree the next steps.', 24, null, 1),
  ('vehicles_imported', 'Help them add or import their vehicles',
   'Offer the vehicle import template or add the first vehicles together.', 72, 'vehicle_added', 2),
  ('drivers_added', 'Help them add their drivers', null, 96, 'driver_added', 3),
  ('team_invited', 'Make sure the team is invited', null, 120, 'user_invited', 4),
  ('app_installed', 'Install the mobile app with the QR connect link',
   'Show the owner the connect link and QR code under Settings.', 120, 'app_installed', 5),
  ('first_transaction', 'See the first payment recorded', null, 168, 'first_transaction', 6),
  ('check_in_call', 'Check-in call after two weeks',
   'Ask how it is going and what is missing; note anything for the product team.', 336, null, 7);

create table onboarding_tasks (
  id                  uuid primary key default uuidv7(),
  tenant_id           uuid not null references tenants (id),
  -- Null for a task staff added by hand.
  template_key        text references onboarding_task_templates (key),
  title               text not null check (length(trim(title)) between 3 and 160),
  description         text check (length(description) <= 1000),
  completes_with      text,
  due_at              timestamptz not null,
  assignee_id         uuid references platform_users (id),
  status              text not null default 'open' check (status in ('open', 'done', 'skipped')),
  done_at             timestamptz,
  done_by             uuid references platform_users (id),
  done_automatically  boolean not null default false,
  note                text check (length(note) <= 1000),
  created_by          uuid references platform_users (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, template_key),
  check ((status = 'open') = (done_at is null))
);

create index onboarding_tasks_open_idx on onboarding_tasks (due_at) where status = 'open';
create index onboarding_tasks_assignee_idx on onboarding_tasks (assignee_id, due_at)
  where assignee_id is not null and status = 'open';
create index onboarding_tasks_template_idx on onboarding_tasks (template_key)
  where template_key is not null;
