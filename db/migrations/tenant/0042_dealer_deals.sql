-- Dealer deals (P7-6, docs/10 §6–7): trade-in appraisals, and the sale of a stock vehicle from
-- the reservation with a deposit through payments, cash, bank or in-house financing, the sales
-- invoice and agreement, to delivery with its checklist and delivery note.

-- A trade-in is taken in as a payment in kind: it posts to 1500 Vehicles, not to a till.
alter table payments drop constraint payments_method_check;
alter table payments add constraint payments_method_check
  check (method in ('cash', 'momo', 'bank_transfer', 'cheque', 'card', 'trade_in'));

insert into ledger_accounts (code, name, type, system_key) values
  ('4310', 'Instalment sale charges', 'income', 'instalment_charges')
on conflict (code) do nothing;

-- Deals are logged on their lead.
alter table dealer_lead_activities drop constraint dealer_lead_activities_kind_check;
alter table dealer_lead_activities add constraint dealer_lead_activities_kind_check
  check (kind in ('call', 'message', 'whatsapp', 'email', 'visit', 'note', 'stage',
    'assignment', 'test_drive', 'quote', 'deal'));

create table dealer_appraisals (
  id               uuid primary key default uuidv7(),
  number           text not null unique,
  branch_id        uuid not null references branches (id),
  lead_id          uuid references dealer_leads (id),
  customer_id      uuid references customers (id),
  status           text not null default 'open' check (status in ('open', 'used', 'declined')),
  make             text not null check (length(make) between 1 and 80),
  model            text not null check (length(model) between 1 and 80),
  year             smallint check (year between 1950 and 2100),
  plate_number     text check (length(plate_number) <= 20),
  vin              text check (length(vin) <= 40),
  colour           text check (length(colour) <= 40),
  mileage          integer check (mileage >= 0),
  condition        text not null check (condition in ('excellent', 'good', 'fair', 'poor')),
  findings         text check (length(findings) <= 2000),
  value_minor      bigint not null check (value_minor > 0),
  valid_until      date not null,
  appraised_by     uuid not null references users (id),
  appraised_on     date not null,
  -- Used on a deal: the stock vehicle it became.
  deal_id          uuid,
  vehicle_id       uuid references vehicles (id),
  declined_reason  text check (length(declined_reason) <= 500),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check ((status = 'declined') = (declined_reason is not null)),
  check (vehicle_id is null or status = 'used')
);

create index dealer_appraisals_listing_idx on dealer_appraisals (created_at desc, id desc);

create table dealer_deals (
  id                     uuid primary key default uuidv7(),
  number                 text not null unique,
  branch_id              uuid not null references branches (id),
  vehicle_id             uuid not null references vehicles (id),
  customer_id            uuid not null references customers (id),
  lead_id                uuid references dealer_leads (id),
  quote_id               uuid references dealer_quotes (id),
  -- Who sells it (their commission comes with P7-7).
  sales_executive_id     uuid not null references users (id),
  status                 text not null default 'draft' check (status in ('draft', 'reserved',
                           'sold', 'delivered', 'cancelled')),
  price_minor            bigint not null check (price_minor >= 0),
  discount_minor         bigint not null default 0 check (discount_minor >= 0),
  -- Below the minimum price, or a discount over the seller's limit: approved before the sale.
  needs_approval         boolean not null default false,
  approved_by            uuid references users (id),
  approved_at            timestamptz,
  trade_in_id            uuid unique references dealer_appraisals (id),
  trade_in_minor         bigint not null default 0 check (trade_in_minor >= 0),
  financing              text not null default 'cash' check (financing in ('cash', 'bank',
                           'in_house')),
  -- Bank: the lender's loan and how far it has got.
  lender                 text check (length(lender) <= 160),
  loan_minor             bigint check (loan_minor > 0),
  loan_status            text check (loan_status in ('applied', 'approved', 'declined',
                           'disbursed')),
  loan_reference         text check (length(loan_reference) <= 80),
  -- In-house: the cash before delivery, the charge and the schedule's shape.
  down_payment_minor     bigint check (down_payment_minor >= 0),
  plan_markup_percent    text check (plan_markup_percent ~ '^\d{1,3}(\.\d{1,2})?$'),
  plan_frequency         text check (plan_frequency in ('weekly', 'monthly')),
  plan_months            smallint check (plan_months between 1 and 120),
  plan_first_due_on      date,
  plan_charge_minor      bigint check (plan_charge_minor >= 0),
  warranty_months        smallint not null default 0 check (warranty_months between 0 and 120),
  service_vouchers       smallint not null default 0 check (service_vouchers between 0 and 20),
  notes                  text check (length(notes) <= 2000),
  hold_until             date,
  reserved_at            timestamptz,
  sold_on                date,
  invoice_id             uuid references invoices (id),
  charge_invoice_id      uuid references invoices (id),
  trade_in_payment_id    uuid references payments (id),
  agreement_document_id  uuid references documents (id),
  delivered_on           date,
  delivery_odometer      integer check (delivery_odometer >= 0),
  delivery_checklist     jsonb,
  delivery_document_id   uuid references documents (id),
  warranty_ends_on       date,
  cancelled_at           timestamptz,
  cancel_reason          text check (length(cancel_reason) <= 500),
  created_by             uuid references users (id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (discount_minor <= price_minor),
  check ((approved_by is null) = (approved_at is null)),
  check ((status = 'reserved') = (hold_until is not null)),
  check ((status in ('sold', 'delivered')) = (sold_on is not null and invoice_id is not null)),
  check ((status = 'delivered') = (delivered_on is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check ((trade_in_id is null) = (trade_in_minor = 0)),
  check ((financing = 'bank') = (lender is not null and loan_minor is not null
    and loan_status is not null)),
  check ((financing = 'in_house') = (down_payment_minor is not null
    and plan_markup_percent is not null and plan_frequency is not null and plan_months is not null))
);

-- One live deal per vehicle.
create unique index dealer_deals_live_vehicle_idx on dealer_deals (vehicle_id)
  where status in ('draft', 'reserved', 'sold');
create index dealer_deals_listing_idx on dealer_deals (created_at desc, id desc);
create index dealer_deals_reserved_idx on dealer_deals (hold_until) where status = 'reserved';

alter table dealer_appraisals add constraint dealer_appraisals_deal_fk
  foreign key (deal_id) references dealer_deals (id);

create table dealer_deal_items (
  id           uuid primary key default uuidv7(),
  deal_id      uuid not null references dealer_deals (id) on delete cascade,
  position     smallint not null check (position > 0),
  kind         text not null check (kind in ('registration', 'tint', 'tracker', 'warranty',
                 'insurance', 'service_plan', 'other')),
  description  text not null check (length(description) between 1 and 300),
  amount_minor bigint not null check (amount_minor >= 0),
  unique (deal_id, position)
);

-- The in-house schedule set at the sale; what is paid follows from the deal's invoices.
create table dealer_deal_instalments (
  deal_id       uuid not null references dealer_deals (id),
  number        smallint not null check (number > 0),
  due_on        date not null,
  amount_minor  bigint not null check (amount_minor > 0),
  -- Told once when it falls overdue.
  overdue_noticed_at timestamptz,
  primary key (deal_id, number)
);
