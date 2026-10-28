-- Supplier payables (P7-2, docs/11 §5): approved expenses to a supplier are its bills, due after
-- the supplier's payment terms; one payment may settle several of them, with withholding tax
-- kept back for the tax authority.

insert into ledger_accounts (code, name, type, system_key) values
  ('2230', 'Withholding tax payable', 'liability', 'withholding_tax')
on conflict (code) do nothing;

-- Open bills by supplier, and the bills one payment settled.
create index expenses_open_bills_idx on expenses (payee_id, expense_date)
  where status = 'approved' and payee_type = 'supplier';
create index expenses_payment_idx on expenses (payment_id) where payment_id is not null;
