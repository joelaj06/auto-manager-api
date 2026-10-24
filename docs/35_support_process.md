# 35 — Support process

How tenants get help once they pay, who answers, how fast, and with which tools. The console tools are in doc 27; the runbooks for incidents, on-call and data protection are in doc 33.

> **Status (2026-10-24): agreed process, local tooling.** Channels and hours below are proposals for the first paying tenants; confirm them before go-live (doc 36 §7). Every tool named here exists in the API today.

## 1. Channels and hours

| Channel | For | Hours |
|---|---|---|
| Email `support@…` (one shared inbox) | Everything; the default | Answered Monday–Saturday, 08:00–18:00 Accra |
| Phone / WhatsApp business line | Owners who cannot sign in, urgent payment or sign-in problems | Same hours; outside them only for SEV1 (on-call, doc 33 §8) |
| Status page (`GET /api/v1/public/status`) | Outages and maintenance | Always; updated by the incident lead |
| Reseller | Their own clients' first-line questions (doc 29) | The reseller's hours; they escalate to us by email with the tenant slug |

Every request gets a **ticket reference** (the inbox thread id or a number from the help desk once there is one). It is the reference used in support access, user support actions and owner recovery, so console trails link back to the request.

## 2. Severity and response times

| Severity | Meaning | First response | Update cadence | Target to resolve or work around |
|---|---|---|---|---|
| **S1** | Tenant cannot work at all, money posted wrongly, data exposed (usually a SEV1/SEV2 incident, doc 33 §5) | 30 min in hours; on-call outside | Every 2 h | Same day |
| **S2** | A module blocked for one tenant (payments, signing, notifications), owner locked out | 2 working hours | Daily | 1 working day |
| **S3** | Something wrong with a workaround; a billing question | 1 working day | When there is news | 5 working days |
| **S4** | How-to questions, feature requests | 2 working days | — | Answer or log the request |

Raise the severity when several tenants report the same thing: it is probably an incident.

## 3. Triage

1. **Identify** the tenant (slug or business name; console tenant search) and the person (console user search across tenants). Never act on a request whose sender you cannot tie to the tenant: owners and administrators can ask for anything, other users only about their own account.
2. **Check what is known first**: open alerts (`GET /api/platform/v1/alerts?status=open`), open incidents, maintenance windows, the tenant's status (read-only, deactivated, over its branch limit) and billing state (overdue invoices, dry-run flags).
3. **Classify** the severity (§2) and say so in the first reply with the next update time.
4. **Reproduce** with the tenant's own view when needed: support access (§4), read-only, reason and ticket.
5. **Fix, work around or escalate** (§5). Write the outcome in the ticket.

## 4. Console tools

| Need | Tool | Guard |
|---|---|---|
| See what the tenant sees | `POST tenants/:id/support-sessions` (read-only, 30 min, up to 2 h) | Reason and ticket; every request logged; the tenant's support log shows it |
| Change something for them | Support session in **write mode** | A second staff member approves; step-up; still no exports, passwords or payments |
| Locked out, lost phone | Users: unlock, force logout, reset-password code, disable/enable | Audited, staff named in the tenant's audit |
| Owner lost their email | Owner recovery (`POST tenants/:id/owner-recovery`) | Identity checks written down; Super Admin approval (doc 33 §4) |
| Wrong payment, wrong terms | The tenant reverses or restructures; we guide them | Never edit ledger rows (doc 33 §3) |
| Billing: invoice, extension, refund | Console billing: invoice, grant extension, record or refund a payment | Refunds above the threshold need a second approver |
| More branches, limit | Branch price impact, add branch, branch-limit override | Confirmed charge; overrides audited |
| Feature off for one tenant | Module toggles and flags | Audited |
| Their data | Data export for the owner (doc 33 §11) | Owner only, or staff for the exit path with a reason |

Anything not on this list is not a support action: escalate.

## 5. Escalation

| From | To | When |
|---|---|---|
| Support | Engineering on call | A bug (wrong result, error with a `requestId`), anything touching money, any S1 |
| Support | Incident (doc 33 §5) | Several tenants affected, data exposure suspected, a module down |
| Support | Super Admin | Owner recovery, large refunds, extensions beyond policy, contract or price questions |
| Support | Data protection (doc 33 §9) | Any request about a person's data: log it the same day |
| Reseller | Support | Anything beyond how-to; with the tenant slug and the user's words |

Always pass on the `requestId` from the error (every API error carries one), the tenant slug, the time and what the user did.

## 6. Billing and reseller questions

- **Invoices and receipts** are in the tenant's billing screen; we resend on request. Payment instructions and the seller's details come from the billing settings.
- **Overdue and deactivation**: reminders and grace follow doc 25. While the automation is in dry run (the first weeks, doc 36 §2) nobody is deactivated automatically; staff act from the dry-run review. Grant an extension rather than argue a late payment.
- **Disputed charges** (branches, proration): open the price impact for the tenant, explain, and refund or credit through the console if we were wrong.
- **Resellers** see their clients' status and their own commissions; they do not see tenant data. Commission questions go to the finance owner (doc 29).

## 7. Data protection in support

- Ask only for what the request needs; never ask for passwords or one-time codes.
- Do not copy tenant data out of support sessions into email or chat; describe it, or point to the screen.
- Screenshots containing personal data are deleted from the ticket when it closes.
- A request about a person's own data (access, correction, erasure, objection) is a data-protection request: log it (doc 33 §9).

## 8. Quality

- Weekly: open tickets by severity and age; anything past its target is discussed.
- Monthly: top five causes of tickets go into the backlog as fixes or help-text changes.
- Support staff are console users with the **Support** role (doc 27); the launch gate warns while there are none (doc 36).
