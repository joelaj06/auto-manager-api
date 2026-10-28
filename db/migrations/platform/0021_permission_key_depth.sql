-- Permission keys may have four parts (docs/28 §5: dealer.stock.cost.view,
-- dealer.stock.price.manage), P7-4.

alter table permission_catalog drop constraint permission_catalog_key_check;
alter table permission_catalog
  add constraint permission_catalog_key_check check (key ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*){1,3}$');
