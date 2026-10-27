-- The rental agreement and the return note (P5-6, docs/07 §6, docs/24 §1): issued through the
-- document engine at check-out and check-in, signed by the renter and the business; the booking
-- records when each is issued and fully signed.

alter table rental_booking_events drop constraint rental_booking_events_type_check;
alter table rental_booking_events add constraint rental_booking_events_type_check
  check (type in ('reserved', 'confirmed', 'changed', 'vehicle_changed', 'checked_out',
    'extended', 'returned', 'closed', 'cancelled', 'no_show', 'damage_charged', 'driver_named',
    'invoiced', 'payment_recorded', 'deposit_held', 'deposit_applied', 'deposit_released',
    'agreement_issued', 'agreement_signed', 'return_issued', 'return_signed'));
