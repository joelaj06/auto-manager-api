-- Notification rules v1 (P2-9, docs/15). The staff inbox, outgoing messages (SMS through the
-- business's own provider account, push to the staff app, email) and the devices that receive
-- push. Settings, rules and the sealed SMS credentials live in organisation.settings.

create table notifications (
  id          uuid primary key default uuidv7(),
  user_id     uuid not null references users (id),
  rule        text not null,
  title       text not null,
  body        text not null,
  severity    text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  -- Ids of what it is about ({ vehicleId, documentId } …) for links in the apps.
  data        jsonb not null default '{}'::jsonb,
  -- The same reminder is never given twice to the same person.
  dedupe_key  text not null,
  read_at     timestamptz,
  created_at  timestamptz not null default now(),
  unique (user_id, dedupe_key)
);

create index notifications_user_idx on notifications (user_id, id desc);
create index notifications_unread_idx on notifications (user_id) where read_at is null;

create table notification_deliveries (
  id                   uuid primary key default uuidv7(),
  channel              text not null check (channel in ('sms', 'push', 'email')),
  rule                 text not null,
  recipient_type       text not null check (recipient_type in ('user', 'driver')),
  recipient_id         uuid not null,
  -- Phone (E.164) for SMS, email address, user id for push.
  address              text not null,
  title                text,
  body                 text not null,
  data                 jsonb not null default '{}'::jsonb,
  dedupe_key           text not null,
  status               text not null default 'queued'
                         check (status in ('queued', 'sent', 'failed', 'skipped')),
  -- Quiet hours and retries push this later.
  send_after           timestamptz not null default now(),
  attempts             integer not null default 0 check (attempts >= 0),
  provider             text,
  provider_message_id  text,
  error                text,
  sent_at              timestamptz,
  created_at           timestamptz not null default now(),
  unique (channel, recipient_id, dedupe_key),
  check ((status = 'sent') = (sent_at is not null))
);

create index notification_deliveries_due_idx on notification_deliveries (send_after)
  where status = 'queued';
create index notification_deliveries_recipient_idx on notification_deliveries (recipient_id, id desc);

-- Staff app installations that receive push (FCM registration tokens).
create table push_devices (
  id            uuid primary key default uuidv7(),
  user_id       uuid not null references users (id),
  token         text not null unique check (length(token) between 20 and 4096),
  platform      text not null check (platform in ('android', 'ios', 'web')),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create index push_devices_user_idx on push_devices (user_id);
