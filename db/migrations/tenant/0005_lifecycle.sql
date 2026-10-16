-- P1-4: sessions can be revoked because the tenant was deactivated; branch deactivation history.

alter table auth_sessions drop constraint auth_sessions_revocation_reason_check;
alter table auth_sessions add constraint auth_sessions_revocation_reason_check
  check (revocation_reason in ('logout', 'refresh_token_reuse', 'password_changed', 'user_disabled',
                               'admin_revoked', 'idle_timeout', 'tenant_deactivated'));

alter table branches
  add column deactivated_at     timestamptz,
  add column deactivated_reason text check (length(deactivated_reason) <= 500);
