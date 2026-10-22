-- Work & Pay completion and transfer (P3-6, docs/08 §5, docs/24 §2): the transfer letter issued
-- when an agreement is paid in full, the vehicle's ownership passing to the driver once both
-- parties signed it, and the DVLA change of ownership tracked as a checklist with attachments.

create table workpay_transfers (
  id                 uuid primary key default uuidv7(),
  agreement_id       uuid not null unique references workpay_agreements (id),
  -- The letter out for signature (a correction replaces it).
  document_id        uuid not null unique references documents (id),
  odometer           integer not null check (odometer >= 0),
  condition          text check (length(condition) <= 500),
  -- [{ item, included }]
  handed_over        jsonb not null default '[]'::jsonb,
  -- Signs for the business.
  owner_signer_id    uuid not null references users (id),
  issued_by          uuid references users (id),
  issued_at          timestamptz not null,
  -- Both parties signed: the vehicle is the driver's.
  transferred_at     timestamptz,
  dvla_status        text not null default 'not_started'
                       check (dvla_status in ('not_started', 'submitted', 'completed')),
  dvla_submitted_on  date,
  dvla_completed_on  date,
  dvla_reference     text check (length(dvla_reference) <= 100),
  dvla_notes         text check (length(dvla_notes) <= 2000),
  updated_at         timestamptz not null default now(),
  check (dvla_status = 'not_started' or transferred_at is not null),
  check ((dvla_status = 'not_started') = (dvla_submitted_on is null)),
  check ((dvla_status = 'completed') = (dvla_completed_on is not null)),
  check (dvla_completed_on is null or dvla_completed_on >= dvla_submitted_on)
);
