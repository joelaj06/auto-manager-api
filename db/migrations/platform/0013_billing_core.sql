-- Billing core (P4-1, docs/25 §2–3, §6): who we are on our invoices and the VAT we charge,
-- tenants' billing details and contacts, proration of branches added mid-period, receipts for
-- payments, and saved payment methods (filled by the gateway, P4-2).

-- Autoforce as the seller: one row. VAT stays off until the accountant confirms registration.
create table billing_settings (
  id                    boolean primary key default true check (id),
  seller_name           text not null check (length(trim(seller_name)) between 2 and 160),
  seller_address        text check (length(seller_address) <= 500),
  seller_tin            text check (length(seller_tin) <= 40),
  seller_email          text check (length(seller_email) <= 200),
  seller_phone          text check (length(seller_phone) <= 40),
  vat_registered        boolean not null default false,
  vat_number            text check (length(vat_number) <= 40),
  -- Tax components on our fee (the tenant tax-code shape: key, name, rate, base, effective dates).
  tax_components        jsonb not null default '[]'::jsonb,
  -- How to pay outside the gateway (bank, MoMo merchant), printed on invoices.
  payment_instructions  text check (length(payment_instructions) <= 1000),
  invoice_due_days      integer not null default 7 check (invoice_due_days between 0 and 60),
  updated_at            timestamptz not null default now(),
  updated_by            uuid references platform_users (id),
  check (not vat_registered or vat_number is not null)
);

insert into billing_settings (seller_name, tax_components) values (
  'Autoforce',
  '[{"key":"vat","name":"VAT","rate":"15","base":"net","effectiveFrom":"2026-01-01","effectiveTo":null},
    {"key":"nhil","name":"NHIL","rate":"2.5","base":"net","effectiveFrom":"2026-01-01","effectiveTo":null},
    {"key":"getfund","name":"GETFund Levy","rate":"2.5","base":"net","effectiveFrom":"2026-01-01","effectiveTo":null}]'
);

-- Who the tenant is on our invoices (the buyer), kept by the tenant.
create table billing_profiles (
  tenant_id    uuid primary key references tenants (id),
  legal_name   text not null check (length(trim(legal_name)) between 2 and 160),
  tin          text check (length(tin) <= 40),
  address      text check (length(address) <= 500),
  updated_at   timestamptz not null default now(),
  -- A tenant user (no foreign key: users live in the tenant database).
  updated_by   uuid
);

-- Who receives invoices, receipts and billing notices.
create table billing_contacts (
  id                uuid primary key default uuidv7(),
  tenant_id         uuid not null references tenants (id),
  name              text not null check (length(trim(name)) between 2 and 120),
  email             citext check (email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  phone             text check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  is_primary        boolean not null default false,
  receives_notices  boolean not null default true,
  created_at        timestamptz not null default now(),
  check (email is not null or phone is not null)
);

create index billing_contacts_tenant_idx on billing_contacts (tenant_id);
create unique index billing_contacts_primary_idx on billing_contacts (tenant_id) where is_primary;

-- Existing tenants: profile and primary contact from their application.
insert into billing_profiles (tenant_id, legal_name, tin)
select t.id, a.business_name, a.tin
  from tenants t join tenant_applications a on a.id = t.application_id
on conflict do nothing;

insert into billing_contacts (tenant_id, name, email, phone, is_primary)
select t.id, a.contact_name, a.contact_email, a.contact_phone, true
  from tenants t join tenant_applications a on a.id = t.application_id
 where not exists (select 1 from billing_contacts c where c.tenant_id = t.id);

-- Branches charged for the current paid period (the paid invoice's count plus prorations), so a
-- branch removed and added again within a period is not charged twice.
alter table subscriptions
  add column period_branch_count integer check (period_branch_count >= 0);

update subscriptions set period_branch_count = branch_count where current_period_end is not null;

-- Charges waiting for the next invoice: a branch added during a paid period, pro rata.
create table billing_adjustments (
  id               uuid primary key default uuidv7(),
  subscription_id  uuid not null references subscriptions (id),
  tenant_id        uuid not null references tenants (id),
  kind             text not null check (kind in ('proration')),
  description      text not null check (length(description) between 1 and 300),
  branches         integer not null check (branches > 0),
  unit_minor       bigint not null check (unit_minor > 0),
  days             integer not null check (days > 0),
  period_days      integer not null check (period_days >= days),
  amount_minor     bigint not null check (amount_minor > 0),
  starts_on        date not null,
  period_end       date not null check (period_end > starts_on),
  -- The invoice that charged it (released again if that invoice is voided).
  invoice_id       uuid references billing_invoices (id),
  created_at       timestamptz not null default now()
);

create index billing_adjustments_pending_idx on billing_adjustments (subscription_id)
  where invoice_id is null;

-- Invoices carry their tax and both parties as issued.
alter table billing_invoices
  add column tax_lines jsonb not null default '[]'::jsonb,
  add column seller    jsonb,
  add column buyer     jsonb;

-- A receipt number for every payment (AF-RCT-2026-000001).
alter table billing_payments add column receipt_number text unique;

alter table billing_payments disable trigger billing_payments_append_only;
update billing_payments p
   set receipt_number = 'AF-RCT-' || extract(year from p.received_at)::int || '-'
                        || lpad(r.n::text, 6, '0')
  from (select id, row_number() over (partition by extract(year from received_at)
                                      order by received_at, id) as n
          from billing_payments) r
 where r.id = p.id;
alter table billing_payments enable trigger billing_payments_append_only;

insert into counters (key, value)
select 'billing_receipt:' || extract(year from received_at)::int, count(*)
  from billing_payments group by extract(year from received_at)
on conflict (key) do update set value = greatest(counters.value, excluded.value);

-- Saved payment methods (a card authorization or a MoMo number), created by the gateway.
create table payment_methods (
  id                    uuid primary key default uuidv7(),
  tenant_id             uuid not null references tenants (id),
  provider              text not null check (provider ~ '^[a-z][a-z_]*$'),
  type                  text not null check (type in ('card', 'momo')),
  -- What the tenant sees: "Visa •• 4081", "MTN MoMo •• 5521". Never a full number.
  label                 text not null check (length(label) between 1 and 80),
  -- The provider's reusable authorization, sealed (AES-GCM); null for MoMo numbers.
  sealed_authorization  text,
  is_default            boolean not null default false,
  expires_on            date,
  created_at            timestamptz not null default now(),
  removed_at            timestamptz
);

create index payment_methods_tenant_idx on payment_methods (tenant_id) where removed_at is null;
create unique index payment_methods_default_idx on payment_methods (tenant_id)
  where is_default and removed_at is null;
