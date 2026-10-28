-- Multi-currency expenses (P7-1, docs/20 §5–6): an expense may be in any enabled currency with
-- its rate to the base currency on the expense date; the base-currency amounts are frozen with
-- it and are what is posted, compared with approval rules and budgets, and reported. Paid at
-- another rate, the exchange difference is kept on the expense.

alter table expenses
  add column currency            char(3),
  add column fx_rate             numeric(20, 10) not null default 1 check (fx_rate > 0),
  add column amount_base_minor   bigint,
  add column net_base_minor      bigint,
  add column tax_base_minor      bigint,
  add column fx_difference_minor bigint not null default 0;

update expenses
   set currency = (select base_currency from organisation limit 1),
       amount_base_minor = amount_minor,
       net_base_minor = net_minor,
       tax_base_minor = tax_minor;

alter table expenses
  alter column currency set not null,
  alter column amount_base_minor set not null,
  alter column net_base_minor set not null,
  alter column tax_base_minor set not null,
  add constraint expenses_base_check check (net_base_minor + tax_base_minor = amount_base_minor),
  add constraint expenses_base_positive check (amount_base_minor > 0);

create index expenses_currency_idx on expenses (currency) where status in ('draft', 'submitted', 'approved');

alter table expense_lines
  add column amount_base_minor bigint,
  add column net_base_minor    bigint,
  add column tax_base_minor    bigint;

update expense_lines
   set amount_base_minor = amount_minor, net_base_minor = net_minor, tax_base_minor = tax_minor;

alter table expense_lines
  alter column amount_base_minor set not null,
  alter column net_base_minor set not null,
  alter column tax_base_minor set not null;
