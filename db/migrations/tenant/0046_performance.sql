-- Performance pass (P8-5, docs/22 §11): an index behind every foreign key a lookup or a parent's
-- delete follows, the ledger's daily totals that the trial balance and tax report read instead of
-- every line ever posted, and autovacuum kept close behind the tables that only grow.

-- Who-did-it columns (created_by, approved_by … pointing at users, who are deactivated and never
-- deleted) are left unindexed: nothing looks rows up by them and a write would pay for each.
-- Nullable columns get partial indexes; `col = $1` still uses them.
create index budgets_branch_id_idx on budgets (branch_id) where branch_id is not null;
create index budgets_category_id_idx on budgets (category_id) where category_id is not null;
create index budgets_vehicle_id_idx on budgets (vehicle_id) where vehicle_id is not null;

create index customers_home_branch_id_idx on customers (home_branch_id) where home_branch_id is not null;

create index daily_vehicle_stats_driver_id_idx on daily_vehicle_stats (driver_id) where driver_id is not null;

create index dealer_appraisals_branch_id_idx on dealer_appraisals (branch_id);
create index dealer_appraisals_customer_id_idx on dealer_appraisals (customer_id) where customer_id is not null;
create index dealer_appraisals_deal_id_idx on dealer_appraisals (deal_id) where deal_id is not null;
create index dealer_appraisals_lead_id_idx on dealer_appraisals (lead_id) where lead_id is not null;
create index dealer_appraisals_vehicle_id_idx on dealer_appraisals (vehicle_id) where vehicle_id is not null;

create index dealer_commission_payouts_branch_id_idx on dealer_commission_payouts (branch_id);
create index dealer_commission_payouts_journal_id_idx on dealer_commission_payouts (journal_id);
create index dealer_commission_payouts_user_id_idx on dealer_commission_payouts (user_id);

create index dealer_commission_plans_user_id_idx on dealer_commission_plans (user_id) where user_id is not null;

create index dealer_commissions_branch_id_idx on dealer_commissions (branch_id);
create index dealer_commissions_claws_back_id_idx on dealer_commissions (claws_back_id) where claws_back_id is not null;
create index dealer_commissions_payout_id_idx on dealer_commissions (payout_id) where payout_id is not null;
create index dealer_commissions_plan_id_idx on dealer_commissions (plan_id) where plan_id is not null;

create index dealer_deals_agreement_document_id_idx on dealer_deals (agreement_document_id) where agreement_document_id is not null;
create index dealer_deals_branch_id_idx on dealer_deals (branch_id);
create index dealer_deals_charge_invoice_id_idx on dealer_deals (charge_invoice_id) where charge_invoice_id is not null;
create index dealer_deals_customer_id_idx on dealer_deals (customer_id);
create index dealer_deals_delivery_document_id_idx on dealer_deals (delivery_document_id) where delivery_document_id is not null;
create index dealer_deals_invoice_id_idx on dealer_deals (invoice_id) where invoice_id is not null;
create index dealer_deals_lead_id_idx on dealer_deals (lead_id) where lead_id is not null;
create index dealer_deals_quote_id_idx on dealer_deals (quote_id) where quote_id is not null;
create index dealer_deals_sales_executive_id_idx on dealer_deals (sales_executive_id);
create index dealer_deals_trade_in_payment_id_idx on dealer_deals (trade_in_payment_id) where trade_in_payment_id is not null;

create index dealer_lead_matches_vehicle_id_idx on dealer_lead_matches (vehicle_id);

create index dealer_lead_pool_user_id_idx on dealer_lead_pool (user_id);

create index dealer_lead_tasks_assigned_to_idx on dealer_lead_tasks (assigned_to) where assigned_to is not null;

create index dealer_leads_customer_id_idx on dealer_leads (customer_id) where customer_id is not null;
create index dealer_leads_vehicle_id_idx on dealer_leads (vehicle_id) where vehicle_id is not null;

create index dealer_quotes_branch_id_idx on dealer_quotes (branch_id);
create index dealer_quotes_customer_id_idx on dealer_quotes (customer_id) where customer_id is not null;
create index dealer_quotes_document_id_idx on dealer_quotes (document_id) where document_id is not null;
create index dealer_quotes_vehicle_id_idx on dealer_quotes (vehicle_id);

create index dealer_stock_transfers_from_branch_id_idx on dealer_stock_transfers (from_branch_id);
create index dealer_stock_transfers_to_branch_id_idx on dealer_stock_transfers (to_branch_id);

create index dealer_test_drives_branch_id_idx on dealer_test_drives (branch_id);
create index dealer_test_drives_vehicle_id_idx on dealer_test_drives (vehicle_id);
create index dealer_test_drives_waiver_document_id_idx on dealer_test_drives (waiver_document_id) where waiver_document_id is not null;

create index document_events_signer_id_idx on document_events (signer_id) where signer_id is not null;

create index document_signers_paper_file_id_idx on document_signers (paper_file_id) where paper_file_id is not null;
create index document_signers_signature_file_id_idx on document_signers (signature_file_id) where signature_file_id is not null;

create index documents_pdf_file_id_idx on documents (pdf_file_id) where pdf_file_id is not null;
create index documents_replaces_id_idx on documents (replaces_id) where replaces_id is not null;
create index documents_signed_pdf_file_id_idx on documents (signed_pdf_file_id) where signed_pdf_file_id is not null;
create index documents_template_id_idx on documents (template_id) where template_id is not null;

create index expense_approval_rules_branch_id_idx on expense_approval_rules (branch_id) where branch_id is not null;
create index expense_approval_rules_category_id_idx on expense_approval_rules (category_id) where category_id is not null;

create index expense_categories_ledger_account_id_idx on expense_categories (ledger_account_id) where ledger_account_id is not null;

create index expenses_approval_rule_id_idx on expenses (approval_rule_id) where approval_rule_id is not null;
create index expenses_category_id_idx on expenses (category_id);
create index expenses_driver_id_idx on expenses (driver_id) where driver_id is not null;

create index fuel_anomalies_driver_id_idx on fuel_anomalies (driver_id) where driver_id is not null;

create index fuel_logs_driver_id_idx on fuel_logs (driver_id) where driver_id is not null;
create index fuel_logs_expense_id_idx on fuel_logs (expense_id) where expense_id is not null;

create index incidents_damage_id_idx on incidents (damage_id) where damage_id is not null;
create index incidents_issue_id_idx on incidents (issue_id) where issue_id is not null;

create index insurance_claims_insurer_id_idx on insurance_claims (insurer_id);

create index invoice_lines_account_id_idx on invoice_lines (account_id);
create index invoice_lines_vehicle_id_idx on invoice_lines (vehicle_id) where vehicle_id is not null;

create index invoices_branch_id_idx on invoices (branch_id);
create index invoices_vehicle_id_idx on invoices (vehicle_id) where vehicle_id is not null;

create index ledger_lines_branch_id_idx on ledger_lines (branch_id) where branch_id is not null;

create index organisation_logo_file_id_idx on organisation (logo_file_id) where logo_file_id is not null;

create index part_moves_branch_id_idx on part_moves (branch_id);
create index part_moves_expense_id_idx on part_moves (expense_id) where expense_id is not null;
create index part_moves_supplier_id_idx on part_moves (supplier_id) where supplier_id is not null;

create index payments_branch_id_idx on payments (branch_id);
create index payments_counter_account_id_idx on payments (counter_account_id) where counter_account_id is not null;
create index payments_vehicle_id_idx on payments (vehicle_id) where vehicle_id is not null;

create index purchase_costs_line_id_idx on purchase_costs (line_id) where line_id is not null;
create index purchase_costs_supplier_id_idx on purchase_costs (supplier_id);

create index recurring_expenses_branch_id_idx on recurring_expenses (branch_id);
create index recurring_expenses_category_id_idx on recurring_expenses (category_id);

create index remittance_submissions_payment_id_idx on remittance_submissions (payment_id) where payment_id is not null;

create index remittances_vehicle_id_idx on remittances (vehicle_id);

create index rental_booking_charges_event_id_idx on rental_booking_charges (event_id);
create index rental_booking_charges_invoice_id_idx on rental_booking_charges (invoice_id) where invoice_id is not null;

create index rental_bookings_class_id_idx on rental_bookings (class_id) where class_id is not null;
create index rental_bookings_driver_id_idx on rental_bookings (driver_id) where driver_id is not null;

create index rental_deposits_refund_payment_id_idx on rental_deposits (refund_payment_id) where refund_payment_id is not null;

create index rental_inspections_vehicle_id_idx on rental_inspections (vehicle_id);

create index rental_rate_plans_branch_id_idx on rental_rate_plans (branch_id) where branch_id is not null;
create index rental_rate_plans_customer_id_idx on rental_rate_plans (customer_id) where customer_id is not null;

create index report_jobs_file_id_idx on report_jobs (file_id) where file_id is not null;
create index report_jobs_schedule_id_idx on report_jobs (schedule_id) where schedule_id is not null;

create index report_schedules_last_job_id_idx on report_schedules (last_job_id) where last_job_id is not null;

create index role_permissions_permission_key_idx on role_permissions (permission_key);

create index roles_based_on_role_id_idx on roles (based_on_role_id) where based_on_role_id is not null;

create index service_due_branch_id_idx on service_due (branch_id);
create index service_due_plan_id_idx on service_due (plan_id);
create index service_due_task_id_idx on service_due (task_id);

create index service_plans_class_id_idx on service_plans (class_id) where class_id is not null;
create index service_plans_group_id_idx on service_plans (group_id) where group_id is not null;
create index service_plans_vehicle_id_idx on service_plans (vehicle_id) where vehicle_id is not null;

create index service_records_task_id_idx on service_records (task_id);

create index traffic_offences_expense_id_idx on traffic_offences (expense_id) where expense_id is not null;

create index user_roles_branch_id_idx on user_roles (branch_id) where branch_id is not null;

create index vehicle_blocks_branch_id_idx on vehicle_blocks (branch_id);
create index vehicle_blocks_class_id_idx on vehicle_blocks (class_id) where class_id is not null;
create index vehicle_blocks_customer_id_idx on vehicle_blocks (customer_id) where customer_id is not null;

create index vehicle_damage_photos_file_id_idx on vehicle_damage_photos (file_id);

create index vehicle_damages_branch_id_idx on vehicle_damages (branch_id);
create index vehicle_damages_inspection_id_idx on vehicle_damages (inspection_id) where inspection_id is not null;

create index vehicle_depreciation_journal_id_idx on vehicle_depreciation (journal_id);

create index vehicles_primary_photo_file_id_idx on vehicles (primary_photo_file_id) where primary_photo_file_id is not null;

create index work_order_allocations_customer_id_idx on work_order_allocations (customer_id) where customer_id is not null;
create index work_order_allocations_driver_id_idx on work_order_allocations (driver_id) where driver_id is not null;
create index work_order_allocations_insurer_id_idx on work_order_allocations (insurer_id) where insurer_id is not null;

create index work_order_lines_part_id_idx on work_order_lines (part_id) where part_id is not null;

create index work_orders_assigned_to_idx on work_orders (assigned_to) where assigned_to is not null;
create index work_orders_block_id_idx on work_orders (block_id) where block_id is not null;
create index work_orders_damage_id_idx on work_orders (damage_id) where damage_id is not null;
create index work_orders_driver_expense_id_idx on work_orders (driver_expense_id) where driver_expense_id is not null;
create index work_orders_expense_id_idx on work_orders (expense_id) where expense_id is not null;
create index work_orders_issue_id_idx on work_orders (issue_id) where issue_id is not null;
create index work_orders_workpay_agreement_id_idx on work_orders (workpay_agreement_id) where workpay_agreement_id is not null;

create index workpay_agreements_assignment_id_idx on workpay_agreements (assignment_id) where assignment_id is not null;
create index workpay_agreements_document_id_idx on workpay_agreements (document_id) where document_id is not null;

create index workpay_allocations_charge_id_idx on workpay_allocations (charge_id) where charge_id is not null;
create index workpay_allocations_instalment_id_idx on workpay_allocations (instalment_id) where instalment_id is not null;
create index workpay_allocations_penalty_id_idx on workpay_allocations (penalty_id) where penalty_id is not null;

create index workpay_settlement_quotes_payment_id_idx on workpay_settlement_quotes (payment_id) where payment_id is not null;

create index workpay_waivers_instalment_id_idx on workpay_waivers (instalment_id) where instalment_id is not null;
create index workpay_waivers_penalty_id_idx on workpay_waivers (penalty_id) where penalty_id is not null;
create index workpay_waivers_quote_id_idx on workpay_waivers (quote_id) where quote_id is not null;

-- The ledger rolled up by day, account and branch (decision 488): the totals hold every line of
-- an entry created before `ledger_rollup.rolled_until`; lines of later entries are read live.
-- Lines are immutable, so a back-dated entry only ever adds to a day's totals.
create table ledger_daily_totals (
  day          date not null,
  account_id   uuid not null references ledger_accounts (id),
  branch_id    uuid references branches (id),
  debit_minor  bigint not null default 0,
  credit_minor bigint not null default 0,
  lines        integer not null default 0,
  constraint ledger_daily_totals_key unique nulls not distinct (day, account_id, branch_id)
);

create index ledger_daily_totals_account_idx on ledger_daily_totals (account_id, day);
create index ledger_daily_totals_branch_idx on ledger_daily_totals (branch_id)
  where branch_id is not null;

create table ledger_rollup (
  id           boolean primary key default true check (id),
  rolled_until timestamptz not null default '-infinity'
);

insert into ledger_rollup default values;

-- The entries posted since the last roll-up, found by when they were created.
create index journal_entries_created_idx on journal_entries (created_at);

-- Rolled-up totals and the lines of entries created since, by day, account and branch.
create view ledger_activity as
  select t.day, t.account_id, t.branch_id, t.debit_minor, t.credit_minor
    from ledger_daily_totals t
  union all
  select e.entry_date, l.account_id, l.branch_id, l.debit_minor, l.credit_minor
    from journal_entries e
    join ledger_lines l on l.entry_id = e.id
   where e.created_at >= (select rolled_until from ledger_rollup);

-- Tables that only grow: vacuumed and analysed after a smaller share of new rows than the
-- default 20 %, so their visibility maps (index-only scans) and statistics keep up.
alter table audit_logs set (autovacuum_vacuum_insert_scale_factor = 0.05,
                            autovacuum_analyze_scale_factor = 0.02);
alter table ledger_lines set (autovacuum_vacuum_insert_scale_factor = 0.05,
                              autovacuum_analyze_scale_factor = 0.02);
alter table journal_entries set (autovacuum_vacuum_insert_scale_factor = 0.05,
                                 autovacuum_analyze_scale_factor = 0.02);
alter table odometer_readings set (autovacuum_vacuum_insert_scale_factor = 0.05,
                                   autovacuum_analyze_scale_factor = 0.02);
alter table notifications set (autovacuum_vacuum_scale_factor = 0.05,
                               autovacuum_analyze_scale_factor = 0.02);
