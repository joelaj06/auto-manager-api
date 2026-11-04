-- P9-7: what an Enterprise business connects to its own systems (decisions 523–527).
-- An API key acts as the user who made it, narrowed to its scopes, and is kept only as a hash.
-- A webhook endpoint receives thin signed events; every delivery is recorded and retried.

create table api_keys (
  id            uuid primary key default uuidv7(),
  name          text not null check (length(trim(name)) between 1 and 100),
  key_hash      text not null unique,
  -- The last characters, so a key can be told apart in a list.
  key_hint      text not null check (length(key_hint) = 4),
  scopes        text[] not null check (cardinality(scopes) between 1 and 300),
  created_by    uuid not null references users (id),
  expires_at    timestamptz,
  last_used_at  timestamptz,
  requests      bigint not null default 0 check (requests >= 0),
  revoked_at    timestamptz,
  revoked_by    uuid references users (id),
  created_at    timestamptz not null default now()
);

create index api_keys_created_by_idx on api_keys (created_by);

create table webhook_endpoints (
  id                   uuid primary key default uuidv7(),
  url                  text not null check (url ~ '^https://' and length(url) <= 2000),
  description          text check (length(description) <= 200),
  events               text[] not null check (cardinality(events) between 1 and 200),
  sealed_secret        text not null,
  status               text not null default 'active' check (status in ('active', 'disabled')),
  disabled_reason      text check (length(disabled_reason) <= 300),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_success_at      timestamptz,
  last_failure_at      timestamptz,
  created_by           uuid references users (id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index webhook_endpoints_events_idx on webhook_endpoints using gin (events)
  where status = 'active';

create table webhook_deliveries (
  id              uuid primary key default uuidv7(),
  endpoint_id     uuid not null references webhook_endpoints (id) on delete cascade,
  event_id        uuid not null,
  event_type      text not null,
  -- The exact JSON sent, kept as text so a retry signs the same bytes.
  body            text not null,
  status          text not null default 'pending'
                    check (status in ('pending', 'delivered', 'failed')),
  attempts        integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  last_status     integer,
  last_error      text check (length(last_error) <= 500),
  delivered_at    timestamptz,
  created_at      timestamptz not null default now(),
  unique (endpoint_id, event_id),
  check ((status = 'pending') = (next_attempt_at is not null)),
  check ((status = 'delivered') = (delivered_at is not null))
);

create index webhook_deliveries_endpoint_idx on webhook_deliveries (endpoint_id, created_at desc);
create index webhook_deliveries_due_idx on webhook_deliveries (next_attempt_at)
  where status = 'pending';
create index webhook_deliveries_created_idx on webhook_deliveries (created_at);
