-- Work & Pay notifications (P3-7, docs/15 §2): guarantors are SMS recipients too (an agreement's
-- guarantors are told when it is some days in arrears, if the business opts in).
alter table notification_deliveries drop constraint notification_deliveries_recipient_type_check;
alter table notification_deliveries add constraint notification_deliveries_recipient_type_check
  check (recipient_type in ('user', 'driver', 'signer', 'guarantor'));
