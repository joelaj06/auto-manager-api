-- P9-6: WhatsApp on the business's own account and reading receipts.
-- WhatsApp messages are notification deliveries on a channel of their own: the provider's later
-- status (delivered, read, failed) is recorded beside the send, found by the provider's message
-- id, and people who reply STOP are kept out (decisions 515–517).
-- A receipt reading is a suggestion from the photo, never a figure in the books (decisions
-- 520–522): it starts from a scan before the expense exists or from a receipt already attached.

alter table notification_deliveries drop constraint notification_deliveries_channel_check;
alter table notification_deliveries add constraint notification_deliveries_channel_check
  check (channel in ('sms', 'push', 'email', 'whatsapp'));
alter table notification_deliveries
  add column provider_status    text check (provider_status in ('sent', 'delivered', 'read', 'failed')),
  add column provider_status_at timestamptz;
create index notification_deliveries_provider_message_idx
  on notification_deliveries (provider_message_id) where provider_message_id is not null;

create table whatsapp_opt_outs (
  phone         text primary key check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  opted_out_at  timestamptz not null default now()
);

create table receipt_reading_settings (
  id             boolean primary key default true check (id),
  -- Off until the business chooses: receipts leave for an outside AI provider.
  enabled        boolean not null default false,
  monthly_limit  integer not null default 500 check (monthly_limit between 1 and 100000),
  updated_by     uuid references users (id),
  updated_at     timestamptz not null default now()
);
insert into receipt_reading_settings default values;

create table receipt_readings (
  id             uuid primary key default uuidv7(),
  file_id        uuid not null unique references files (id),
  -- Null while a scan waits for its expense.
  expense_id     uuid references expenses (id),
  status         text not null default 'uploading'
                   check (status in ('uploading', 'queued', 'done', 'failed', 'skipped')),
  merchant       text check (length(merchant) <= 200),
  receipt_date   date,
  -- As printed, in the receipt's currency.
  total          numeric(18, 4) check (total >= 0),
  tax            numeric(18, 4) check (tax >= 0),
  currency       text check (currency ~ '^[A-Z]{3}$'),
  is_receipt     boolean,
  confidence     text check (confidence in ('high', 'medium', 'low')),
  model          text,
  input_tokens   integer check (input_tokens >= 0),
  output_tokens  integer check (output_tokens >= 0),
  error          text,
  created_by     uuid references users (id),
  created_at     timestamptz not null default now(),
  queued_at      timestamptz,
  read_at        timestamptz
);

create index receipt_readings_expense_idx on receipt_readings (expense_id);
create index receipt_readings_queued_idx on receipt_readings (queued_at);
create index receipt_readings_waiting_idx on receipt_readings (created_at) where expense_id is null;
