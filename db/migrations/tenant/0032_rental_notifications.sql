-- Rental notifications (P5-7, docs/07 §10): rental customers are SMS and email recipients
-- (confirmations, pickup and return reminders, overdue returns, receipts and invoices).
alter table notification_deliveries drop constraint notification_deliveries_recipient_type_check;
alter table notification_deliveries add constraint notification_deliveries_recipient_type_check
  check (recipient_type in ('user', 'driver', 'signer', 'guarantor', 'customer'));
