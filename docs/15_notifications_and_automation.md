# 15 — Notifications & Automation

> **Update 2026-10-13 (decision 17):** SMS runs on the **tenant's own provider account**. Each tenant stores provider (e.g. Hubtel, Arkesel, mNotify, Twilio), sender ID and API credentials (encrypted at rest; settings permission `settings.notifications.manage`). The platform does **not** sell SMS credits and does not meter SMS usage; delivery status/cost come from the tenant's provider response. If a tenant has no SMS provider configured, SMS rules are skipped and the in-app/email fallback is used. Platform-level emails (invitations, password reset, billing notices) use our own email provider. WhatsApp likewise uses the tenant's own business account when added.

## 1. Channels

| Channel | Provider ideas | Best for |
|---|---|---|
| SMS | Hubtel, Arkesel, mNotify, Twilio | Drivers, customers — highest reach in Ghana |
| WhatsApp | WhatsApp Cloud API (templates), via 360dialog/Twilio | Receipts, statements, booking confirmations, payment links |
| Email | Replace Gmail SMTP with SES / Postmark / Resend | Owners, staff, PDFs, scheduled reports |
| Push | FCM (`deviceToken` already stored on user) | Mobile app users |
| In-app | `notifications` collection + unread count | Staff web app bell |

Abstraction: `NotificationService.send({ to: Recipient, template: "workpay.installment_overdue", data, channels? })`. Templates per tenant (overridable text, language: English first; Twi/Ga/Ewe/French later), sender ID per tenant for SMS.

## 2. Automation rules (configurable per tenant)

| Trigger | Default action |
|---|---|
| Vehicle document expires in 30/14/3 days | Notify fleet manager (in-app + email), mark vehicle amber/red |
| Driver licence expires in 60/30 days | Notify driver (SMS) + manager |
| Service due / overdue | Notify manager + driver |
| W&P installment due tomorrow | SMS driver with payment link |
| W&P installment overdue (after grace) | SMS driver; day 3 notify guarantor (opt-in); escalate to manager at default threshold |
| Remittance not received by cut-off | Notify supervisor; SMS driver |
| Rental pickup tomorrow / return in 2h / overdue | Customer + agent |
| Payment received | Receipt to payer (SMS/WhatsApp) |
| Expense awaiting approval | Approver (push/in-app), daily digest |
| Budget 80% / 100% | Owner |
| Vehicle idle > N days | Manager |
| Import ETA / demurrage risk | Purchasing staff |
| Aged stock > 90 days | Dealer manager |
| Subscription trial ending / past due | Tenant owner (platform) |

Rule model: `{ event, conditions (JSON logic), delayOrSchedule, channels, recipients (roles/users/party), template, enabled, quietHours }`.

## 3. Scheduler

- Platform cron enqueues per-tenant jobs (respecting tenant timezone): `daily-maintenance`, `workpay-daily`, `documents-expiry`, `remittance-cutoff`, `reports-scheduled`, `stats-rollup`.
- Jobs idempotent per `(tenant, job, date)`.

## 4. Delivery tracking & cost control

- `notifications` stores status (queued/sent/delivered/failed), provider id, cost.
- SMS credits per tenant (plan allowance + top-ups) — block or warn when exhausted.
- Opt-out handling (marketing vs transactional).
- Quiet hours (no SMS 21:00–07:00 except critical).

## 5. Activity feed

- Every module emits events → `activity` entries shown on entity timelines (vehicle, driver, customer) and a global feed for owners.
