-- Performance pass (P8-5, docs/22 §11): an index behind every foreign key a lookup or a parent's
-- delete follows, and autovacuum kept close behind the tables that only grow.

-- Who-did-it columns (created_by, decided_by … pointing at platform users, who are deactivated
-- and never deleted) are left unindexed. Nullable columns get partial indexes.
create index announcement_reads_tenant_id_idx on announcement_reads (tenant_id);

create index announcements_approval_id_idx on announcements (approval_id) where approval_id is not null;

create index billing_adjustments_invoice_id_idx on billing_adjustments (invoice_id) where invoice_id is not null;
create index billing_adjustments_tenant_id_idx on billing_adjustments (tenant_id);

create index billing_notices_invoice_id_idx on billing_notices (invoice_id) where invoice_id is not null;

create index billing_payments_invoice_id_idx on billing_payments (invoice_id);

create index billing_refunds_invoice_id_idx on billing_refunds (invoice_id);
create index billing_refunds_tenant_id_idx on billing_refunds (tenant_id);

create index data_protection_requests_assigned_to_idx on data_protection_requests (assigned_to) where assigned_to is not null;
create index data_protection_requests_tenant_id_idx on data_protection_requests (tenant_id) where tenant_id is not null;

create index enterprise_quotes_subscription_id_idx on enterprise_quotes (subscription_id);

create index feature_flag_overrides_tenant_id_idx on feature_flag_overrides (tenant_id);

create index gateway_transactions_payment_method_id_idx on gateway_transactions (payment_method_id) where payment_method_id is not null;
create index gateway_transactions_tenant_id_idx on gateway_transactions (tenant_id);

create index legal_acceptances_tenant_id_idx on legal_acceptances (tenant_id) where tenant_id is not null;

create index partner_commission_entries_invoice_id_idx on partner_commission_entries (invoice_id) where invoice_id is not null;
create index partner_commission_entries_payout_id_idx on partner_commission_entries (payout_id) where payout_id is not null;
create index partner_commission_entries_tenant_id_idx on partner_commission_entries (tenant_id) where tenant_id is not null;
create index partner_commission_entries_terms_id_idx on partner_commission_entries (terms_id) where terms_id is not null;

create index partner_payout_items_entry_id_idx on partner_payout_items (entry_id);

create index partner_permission_grants_permission_key_idx on partner_permission_grants (permission_key);

create index partner_tenant_attributions_application_id_idx on partner_tenant_attributions (application_id) where application_id is not null;
create index partner_tenant_attributions_commission_invoice_id_idx on partner_tenant_attributions (commission_invoice_id) where commission_invoice_id is not null;
create index partner_tenant_attributions_terms_id_idx on partner_tenant_attributions (terms_id) where terms_id is not null;

create index platform_alerts_tenant_id_idx on platform_alerts (tenant_id) where tenant_id is not null;

create index platform_approval_requests_target_tenant_id_idx on platform_approval_requests (target_tenant_id) where target_tenant_id is not null;

create index platform_role_permissions_permission_key_idx on platform_role_permissions (permission_key);

create index platform_user_roles_role_id_idx on platform_user_roles (role_id);

create index role_template_permissions_permission_key_idx on role_template_permissions (permission_key);

create index subscription_price_items_invoice_id_idx on subscription_price_items (invoice_id) where invoice_id is not null;
create index subscription_price_items_quote_id_idx on subscription_price_items (quote_id);

create index subscriptions_plan_id_idx on subscriptions (plan_id);

create index support_sessions_approval_id_idx on support_sessions (approval_id) where approval_id is not null;

create index tenant_applications_assigned_to_idx on tenant_applications (assigned_to) where assigned_to is not null;

alter table platform_audit_logs set (autovacuum_vacuum_insert_scale_factor = 0.05,
                                     autovacuum_analyze_scale_factor = 0.02);
alter table api_usage set (autovacuum_vacuum_scale_factor = 0.05,
                           autovacuum_analyze_scale_factor = 0.02);
alter table usage_daily set (autovacuum_vacuum_insert_scale_factor = 0.05,
                             autovacuum_analyze_scale_factor = 0.02);
alter table email_deliveries set (autovacuum_vacuum_scale_factor = 0.05,
                                  autovacuum_analyze_scale_factor = 0.02);
