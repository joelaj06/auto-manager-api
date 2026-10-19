-- Parties (P2-3, docs/05 §2.2, docs/09 §4, docs/07 §KYC): drivers with licence, guarantors and
-- status; customers with KYC and risk status; suppliers. Separate tables (decision 13).

create table drivers (
  id                 uuid primary key default uuidv7(),
  code               text not null unique,
  first_name         text not null check (length(first_name) between 1 and 80),
  last_name          text not null check (length(last_name) between 1 and 80),
  other_names        text,
  phone              text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  alt_phone          text check (alt_phone is null or alt_phone ~ '^\+[1-9][0-9]{7,14}$'),
  email              citext,
  date_of_birth      date,
  gender             text check (gender in ('female', 'male')),
  address            text,
  ghana_card_number  text check (ghana_card_number is null or ghana_card_number ~ '^GHA-[0-9]{9}-[0-9]$'),
  licence_number     text,
  licence_class      text check (licence_class in ('A', 'B', 'C', 'D', 'E', 'F')),
  licence_issued_on  date,
  licence_expires_on date,
  employment_type    text not null default 'remittance'
                       check (employment_type in ('remittance', 'workpay', 'salary', 'chauffeur')),
  status             text not null default 'applicant'
                       check (status in ('applicant', 'active', 'suspended', 'terminated')),
  status_reason      text,
  status_changed_at  timestamptz not null default now(),
  hired_on           date,
  terminated_on      date,
  branch_id          uuid not null references branches (id),
  -- { name, phone, relationship }
  emergency_contact  jsonb,
  -- { momoNumber, momoNetwork, momoName, bankName, bankBranch, accountName, accountNumber }
  payout             jsonb,
  tags               text[] not null default '{}',
  notes              text,
  created_by         uuid references users (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  deleted_reason     text,
  check ((deleted_at is null) = (deleted_reason is null)),
  check (licence_expires_on is null or licence_issued_on is null or licence_expires_on > licence_issued_on)
);

create unique index drivers_phone_idx on drivers (phone) where deleted_at is null;
create unique index drivers_ghana_card_idx on drivers (ghana_card_number)
  where ghana_card_number is not null and deleted_at is null;
create unique index drivers_licence_idx on drivers (upper(licence_number))
  where licence_number is not null and deleted_at is null;
create index drivers_branch_status_idx on drivers (branch_id, status) where deleted_at is null;
create index drivers_listing_idx on drivers (created_at desc, id desc) where deleted_at is null;
create index drivers_licence_expiry_idx on drivers (licence_expires_on)
  where deleted_at is null and status <> 'terminated';

create table driver_guarantors (
  id                uuid primary key default uuidv7(),
  driver_id         uuid not null references drivers (id),
  name              text not null check (length(name) between 1 and 120),
  phone             text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  relationship      text,
  address           text,
  occupation        text,
  ghana_card_number text check (ghana_card_number is null or ghana_card_number ~ '^GHA-[0-9]{9}-[0-9]$'),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index driver_guarantors_driver_idx on driver_guarantors (driver_id);

create table customers (
  id                   uuid primary key default uuidv7(),
  code                 text not null unique,
  type                 text not null check (type in ('individual', 'corporate')),
  -- Individuals: first and last name; companies: the company name. `name` is what lists show.
  first_name           text,
  last_name            text,
  company_name         text,
  name                 text not null check (length(name) between 1 and 160),
  phone                text check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  alt_phone            text check (alt_phone is null or alt_phone ~ '^\+[1-9][0-9]{7,14}$'),
  email                citext,
  address              text,
  date_of_birth        date,
  occupation           text,
  ghana_card_number    text check (ghana_card_number is null or ghana_card_number ~ '^GHA-[0-9]{9}-[0-9]$'),
  licence_number       text,
  licence_class        text check (licence_class in ('A', 'B', 'C', 'D', 'E', 'F')),
  licence_expires_on   date,
  -- Corporate accounts.
  registration_number  text,
  tin                  text,
  contact_person       text,
  credit_limit_minor   bigint check (credit_limit_minor >= 0),
  payment_terms_days   integer check (payment_terms_days between 0 and 365),
  risk_status          text not null default 'ok' check (risk_status in ('ok', 'watch', 'blacklisted')),
  risk_reason          text,
  risk_changed_at      timestamptz,
  source               text check (source in ('walk_in', 'referral', 'website', 'social',
                         'phone', 'corporate', 'other')),
  -- Where the customer was registered (reports); customers are shared by every branch.
  home_branch_id       uuid references branches (id),
  tags                 text[] not null default '{}',
  notes                text,
  created_by           uuid references users (id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  deleted_reason       text,
  check ((deleted_at is null) = (deleted_reason is null)),
  check (type = 'individual' or company_name is not null),
  check ((risk_status = 'ok') = (risk_reason is null))
);

create unique index customers_email_idx on customers (email)
  where email is not null and deleted_at is null;
create unique index customers_ghana_card_idx on customers (ghana_card_number)
  where ghana_card_number is not null and deleted_at is null;
create index customers_phone_idx on customers (phone) where deleted_at is null;
create index customers_name_trgm_idx on customers using gin (lower(name) gin_trgm_ops)
  where deleted_at is null;
create index customers_listing_idx on customers (created_at desc, id desc) where deleted_at is null;

create table suppliers (
  id                 uuid primary key default uuidv7(),
  code               text not null unique,
  name               text not null check (length(name) between 1 and 160),
  type               text not null check (type in ('dealer', 'auction', 'importer', 'individual',
                       'workshop', 'parts', 'fuel', 'insurer', 'clearing_agent', 'other')),
  contact_person     text,
  phone              text check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  email              citext,
  address            text,
  tin                text,
  payment_terms_days integer check (payment_terms_days between 0 and 365),
  payout             jsonb,
  active             boolean not null default true,
  tags               text[] not null default '{}',
  notes              text,
  created_by         uuid references users (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  deleted_reason     text,
  check ((deleted_at is null) = (deleted_reason is null))
);

create unique index suppliers_name_idx on suppliers (lower(name)) where deleted_at is null;
create index suppliers_listing_idx on suppliers (lower(name)) where deleted_at is null;

-- Identity and onboarding documents of drivers, their guarantors and customers (KYC); scans
-- are files owned by the document.
create table party_documents (
  id          uuid primary key default uuidv7(),
  party_type  text not null check (party_type in ('driver', 'driver_guarantor', 'customer')),
  party_id    uuid not null,
  type        text not null check (type in ('ghana_card', 'passport', 'drivers_licence',
                'voters_id', 'passport_photo', 'proof_of_address', 'police_report', 'contract',
                'business_registration', 'other')),
  number      text,
  issued_on   date,
  expires_on  date,
  notes       text,
  created_by  uuid references users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (expires_on is null or issued_on is null or expires_on >= issued_on)
);

create index party_documents_party_idx on party_documents (party_type, party_id, type);
create index party_documents_expiry_idx on party_documents (expires_on) where expires_on is not null;

-- Driver status and customer risk changes, with their reason.
create table party_status_history (
  id          uuid primary key default uuidv7(),
  party_type  text not null check (party_type in ('driver', 'customer')),
  party_id    uuid not null,
  from_status text,
  to_status   text not null,
  reason      text,
  changed_by  uuid references users (id),
  changed_at  timestamptz not null default now()
);

create index party_status_history_party_idx on party_status_history (party_type, party_id, changed_at desc);
