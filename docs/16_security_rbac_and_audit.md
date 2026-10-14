# 16 — Security, RBAC & Audit

> **Update 2026-10-13:** the RBAC model (§2) is superseded and detailed in [28_tenant_roles_permissions_and_seeding.md](28_tenant_roles_permissions_and_seeding.md) — permission catalogue seeded from the platform DB into each tenant DB at creation, system vs custom roles, branch-aware assignments, scopes and limits, runtime evaluation without permissions in the JWT. Platform staff security (MFA, four-eyes, impersonation) is specified in [27](27_platform_admin_console.md) §2. The immediate fixes in §1 and the audit/data-protection sections still apply.

## 1. Immediate fixes (P0 — before real tenants)

| Ref | Fix |
|---|---|
| C1 | Add `tid` claim; reject token if `tid ≠ resolved tenant`. Slim payload (`sub`, `tid`, `sid`, `ver`). |
| C2 | Platform routes require **platform** auth (separate `platform_users`, separate secret/audience) — never tenant tokens. Remove from tenant router. |
| C3 | Remove public `/api/auth/register` inside tenants or make it create a user with **no role / Driver role pending approval**. Prefer invitations. Tenant sign-up happens on the platform signup flow. |
| C4 | 15-min access + rotating refresh tokens (`sessions`), revoke on password change / deactivate / role change. |
| C5 | Fail fast at boot if `JWT_SECRET` (and other required env) is missing or weak. Validate config with zod. |
| C6 | Never return `stack` outside development; redact sensitive fields in logs (`password`, `newPassword`, `currentPassword`, `otp`, `token`, `authorization`). |
| C7 | Escape regex input (`escapeRegExp`) or move to Atlas Search / `$text`. |
| — | Validate all inputs (zod); whitelist updatable fields (mass assignment). |
| — | `helmet`, rate limiting (login, OTP, password reset: per IP + per account), body size limits. |
| — | OTPs: hash at rest, max 5 attempts, TTL index, single active OTP per purpose; generic responses on reset ("if the email exists…") to avoid user enumeration. |
| — | `bcrypt` async API, cost ≥ 12 (or argon2id). |
| — | Ensure soft-deleted / disabled users can't log in; check `status` on every token refresh. |

## 2. RBAC model (v2)

### 2.1 Permission naming
`<module>.<resource>.<action>` e.g. `rentals.bookings.checkout`, `finance.payments.reverse`. Current values like `view:vehi-cle` (typo) migrate via mapping table.

### 2.2 Scope (row-level)
Each grant has a scope:
- `own` — records where `createdBy = me` or `driverId = myDriverId` / `assignedTo = me`
- `branch` — records in my `branchIds`
- `all` — whole tenant

Implemented as a repository-level **policy filter** injected from request context (so a forgotten filter in a controller can't leak data). Replaces today's `view:others-sales`, `view:sales-filter-by-driver` etc.

### 2.3 Field-level visibility
Sensitive fields gated by permission: vehicle cost / book value / min price, profit, driver bank details, customer ID numbers. Response mappers drop fields the user can't see.

### 2.4 Limits on actions
Role-level numeric limits: max discount %, max expense approval amount, max penalty waiver. Stored on the role: `limits: { "rentals.discount.maxPercent": 10 }`.

### 2.5 System roles seeded per tenant
Owner (all, can't be deleted), Manager, Fleet Officer, Rental Agent, Sales Executive, Accountant/Cashier, Mechanic, Driver (own scope, app-only), Viewer/Auditor (read-only). Tenants can clone and customise.

### 2.6 Permission cache
`permVersion` on role; user token carries `ver`; on mismatch reload from DB into Redis. Role edits take effect within seconds.

## 3. Audit trail

- Tenant `audit_logs`: who, what (`entityType`, `entityId`, `action`), before/after diff (redacted), when, IP, user agent, requestId.
- Written by a Mongoose plugin / repository hook for create/update/delete + explicit entries for business actions (approve, waive, reverse, export, login, failed login, permission change, impersonation).
- Immutable (no update/delete API); retention per plan (e.g. 1 year Starter, 7 years Enterprise), archived to cold storage.
- UI: audit tab on every entity + global filterable log.

## 4. Data protection

- Ghana Data Protection Act 2012 (Act 843) — tenants are controllers, we are processor: DPA template, data export & deletion on request, breach notification process. (Confirm legal requirements — doc 19.)
- Encrypt sensitive PII at field level (ID numbers, bank/MoMo numbers) with per-tenant data keys (envelope encryption) — at least for payment provider secrets.
- File access via short-lived signed URLs; private buckets for documents (IDs, contracts).
- PII minimisation in logs and analytics.

## 5. Platform security

- Platform admin MFA mandatory; IP allow-list optional.
- Impersonation: reason required, time-boxed token with `imp` claim, full audit, visible banner.
- Secrets in a secret manager (Doppler / AWS Secrets Manager / Vercel/Render env with rotation), never in Tenant documents.
- Dependency scanning (Dependabot / `npm audit`), SAST in CI, `.env` never committed (already ignored — keep it that way).
- Backups tested quarterly (restore drill).

## 6. Security test checklist (CI)

- Cross-tenant token reuse → 401.
- Tenant token on platform routes → 401.
- User with `own` scope cannot fetch another driver's remittance by id → 404.
- Mass-assignment: `PATCH /expenses/:id { status: "approved" }` by submitter → ignored/403.
- Rate limit on login triggers after N attempts.
- Error responses contain no stack in production mode.
