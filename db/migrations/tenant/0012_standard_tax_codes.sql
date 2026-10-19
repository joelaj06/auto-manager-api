-- Standard tax codes (P2-5, decision 168, refines decisions 100 and 144). Ghana businesses get
-- the standard rate as one code with its three levies on the same taxable value (VAT Act 2025,
-- Act 1151, from 1 January 2026: VAT 15%, NHIL 2.5%, GETFund 2.5% = 20%), plus zero-rated and
-- exempt codes. Every business can still end, change or add rate periods. New tenants get the
-- same from the provisioning seeder; this brings existing tenants up to date.

-- The separate VAT / NHIL / GETFund placeholders are replaced by the combined code (unused so
-- far: no document can reference a code without rates).
delete from tax_codes
 where code in ('VAT', 'NHIL', 'GETFUND') and components = '[]'::jsonb and not active;

insert into tax_codes (code, name, kind, applies_to, components, active, notes)
select 'VAT_STANDARD', 'Standard rate (VAT + NHIL + GETFund)', 'standard',
       array['sales', 'purchases'],
       jsonb_build_array(
         jsonb_build_object('id', gen_random_uuid()::text, 'key', 'vat', 'name', 'VAT',
           'rate', '15', 'base', 'net', 'effectiveFrom', '2026-01-01', 'effectiveTo', null),
         jsonb_build_object('id', gen_random_uuid()::text, 'key', 'nhil', 'name', 'NHIL',
           'rate', '2.5', 'base', 'net', 'effectiveFrom', '2026-01-01', 'effectiveTo', null),
         jsonb_build_object('id', gen_random_uuid()::text, 'key', 'getfund', 'name', 'GETFund Levy',
           'rate', '2.5', 'base', 'net', 'effectiveFrom', '2026-01-01', 'effectiveTo', null)),
       true,
       'Ghana standard rate from 1 January 2026 (Act 1151). Check with your accountant; add a new rate period when the law changes.'
  from organisation
 where country = 'GH'
on conflict (code) do nothing;

insert into tax_codes (code, name, kind, applies_to, components, active, notes)
select code, name, kind, array['sales', 'purchases'], '[]'::jsonb, true, notes
  from (values
    ('ZERO_RATED', 'Zero-rated supply', 'zero_rated', 'Taxable at 0% (e.g. exports)'),
    ('EXEMPT', 'Exempt supply', 'exempt', 'Outside VAT (e.g. exempt supplies under the Act)')
  ) as t (code, name, kind, notes)
 where exists (select 1 from organisation)
on conflict (code) do nothing;
