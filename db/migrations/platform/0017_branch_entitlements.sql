-- Branch management and entitlements (P4-5, docs/27 §3.5, docs/22 §2.7): billed branches against
-- the tenant database's active branches, over-limit tracking and the reconcile log.

-- Since when the tenant has had more active branches than it pays for (null: within its limit).
alter table subscriptions add column over_limit_since timestamptz;

-- Every comparison of the billed branch count with the tenant's active branches.
create table branch_reconciliations (
  id                   uuid primary key default uuidv7(),
  tenant_id            uuid not null references tenants (id),
  active_branches      integer check (active_branches >= 0),
  billed_before        integer,
  billed_after         integer,
  branches_max         integer,
  subscription_status  text,
  -- matched: nothing to do; fixed: billed count corrected; over_limit: more active branches
  -- than paid for (staff decide); failed: the tenant database could not be read.
  outcome              text not null check (outcome in ('matched', 'fixed', 'over_limit', 'failed')),
  source               text not null check (source in ('job', 'staff')),
  error                text check (length(error) <= 500),
  created_at           timestamptz not null default now()
);

create index branch_reconciliations_tenant_idx on branch_reconciliations (tenant_id, created_at desc);
create index branch_reconciliations_outcome_idx on branch_reconciliations (outcome, created_at desc)
  where outcome <> 'matched';
