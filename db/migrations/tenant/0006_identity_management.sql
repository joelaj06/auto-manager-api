-- P1-5: sign-in lockout and role cloning.

alter table users
  add column failed_attempts integer not null default 0 check (failed_attempts >= 0),
  add column locked_until    timestamptz,
  add column invited_by      uuid references users (id);

alter table roles
  add column based_on_role_id uuid references roles (id);

-- Listing a branch's people and a role's holders.
create index user_roles_user_idx on user_roles (user_id);
create index user_roles_role_idx on user_roles (role_id);
create index user_branches_branch_idx on user_branches (branch_id);
