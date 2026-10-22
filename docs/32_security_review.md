# 32 — Security review before the private beta

Internal penetration test of the API against the **OWASP Top 10 (2021)**, done for P3-8 (2026-10-22) on a local stack. It combines automated attacks that run on every CI build, a dependency audit, and a review of what only a deployed system can show. Design background: [16](16_security_rbac_and_audit.md); earlier findings C1–C7: [01](01_current_state_assessment.md).

> **Scope.** The tenant API (`/api/v1`), the platform API where it shares middleware, and the driver app endpoints, as run locally. Not in scope: the web portal, the mobile apps, hosting (TLS, network, WAF), which come with P0-3.

## 1. Automated tests

| Suite | Runs | What it attacks |
|---|---|---|
| `src/framework/security/owasp.int.test.ts` | Every integration run | The checks in §2 marked **T**, through the real HTTP app |
| `src/framework/security/auditRegressions.test.ts` | Every unit run | C1–C7 of doc 01: cross-tenant tokens, platform/tenant separation, stale permissions, weak secrets, stack traces, dynamic regular expressions |
| `src/testing/isolation` | Every integration run | Every tenant table: no row of tenant A reaches tenant B; the app role owns nothing; append-only tables |
| `src/framework/e2e/moneyFlows.int.test.ts` | Every integration run | Money integrity end to end (A04/A08: the books cannot be pushed out of balance through the API) |

## 2. OWASP Top 10 checklist

**T** = automated test, **R** = reviewed in the code, **H** = needs hosting.

| # | Risk | Check | How | Result |
|---|---|---|---|---|
| A01 | Broken access control | A branch-scoped manager gets 404 for another branch's agreement, statement and list entries | T | Pass |
| | | A driver gets 404 for another driver's agreement statement (JSON and PDF) and transfer letter | T | Pass |
| | | A driver login gets 403 on staff routes (vehicles, agreements, payments) | T | Pass |
| | | Mass assignment: `status`, `depositPaidMinor`, `approvedBy` sent by a client are ignored (zod strips unknown fields; status changes only through use cases) | T | Pass |
| | | Tenant A's token on tenant B; tenant tokens on platform routes and back | T (C1, C2) | Pass |
| | | Own-scope permissions (an expense's creator, a driver's own records) | T (expenses, driver app suites) | Pass |
| A02 | Cryptographic failures | Unsigned (`alg: none`) and re-signed tokens rejected; per-tenant signing keys | T | Pass |
| | | Passwords: Argon2id hashes, never logged (C6); provider secrets sealed with AES-GCM (`AesGcmSecretBox`); backups encrypted with RSA-4096 + AES-256-GCM | R, T | Pass |
| | | Ghana Card and licence numbers are stored in clear (doc 16 §4 asks for field-level encryption of IDs) | R | **Finding F1** |
| | | TLS everywhere, HSTS honoured behind the proxy | H | Open |
| A03 | Injection | SQL in search, filters and cursors is text or a 400, never SQL (all queries are parameterised; no string-built SQL from input) | T, R | Pass |
| | | Ids that are not UUIDs → 400 `VALIDATION_FAILED` | T | Pass |
| | | Document templates: a safe Mustache dialect and an HTML subset, no code; SMS placeholders checked against a list | R, T (template suites) | Pass |
| A04 | Insecure design | Money rules in the domain (allocation, waivers, settlement, reversal) with integrity checks after every step of the e2e flow | T | Pass |
| | | One-time, hashed signing links; OTP attempts counted outside the signing transaction | T (signing suite) | Pass |
| A05 | Security misconfiguration | Helmet headers (`nosniff`, CSP, HSTS, frame options), no `x-powered-by` | T | Pass |
| | | CORS: an unknown origin gets no grant | T | Pass |
| | | Bodies over the limit → 413; unknown routes → JSON 404 without internals; server errors without stacks (C6) | T | Pass |
| | | Secrets required at start, no defaults, minimum lengths (C5) | T | Pass |
| A06 | Vulnerable components | `yarn audit`: production dependencies **0** advisories (191 packages). Development: 8 advisories, all through `eslint-plugin-boundaries`; `handlebars` pinned to ≥ 4.7.10 (6 fixed); `braces` ≤ 3.0.3 has no fixed release (2 high, ReDoS in a lint-time glob matcher, never in the API) | R | **Accepted A1** |
| A07 | Identification and authentication failures | Expired access tokens rejected | T | Pass |
| | | The same answer for an unknown account and a wrong password (no enumeration) | T | Pass |
| | | Brute force: per-IP rate limit on `/auth` (429), per-account lockout after repeated failures, 12+ character passwords not on the common list (NIST 800-63B style) | T, R | Pass |
| | | Tokens older than a role change or a disable are refused (C4) | T | Pass |
| | | Staff (platform console) use TOTP; **tenant users have no second factor yet** | R | **Finding F2** |
| A08 | Software and data integrity failures | Uploads: only allowed content types per kind (no SVG or HTML), size limits, presigned uploads confirmed by the server | T | Pass |
| | | Issued documents immutable (database triggers) with SHA-256 and public verification | T (documents suite) | Pass |
| | | CI: lockfile installs (`--frozen-lockfile`) | R | Pass |
| A09 | Security logging and monitoring failures | Audit trail of every business action and sign-in; security alerts for cross-tenant attempts; secrets redacted in logs (C6) | T, R | Pass |
| | | Alerting on the logs (failed sign-in bursts, 5xx rates) | H | Open |
| A10 | Server-side request forgery | No endpoint fetches a URL a client supplies; outbound calls go to fixed SMS / push / email providers chosen in configuration | R | Pass |

## 3. Findings

| Id | Severity | Finding | Decision |
|---|---|---|---|
| F1 | 🟠 High (data protection) | National ID (Ghana Card) and licence numbers are stored in clear in tenant databases. Backups are encrypted and the databases are not reachable from outside, but a database compromise would expose them. | Field-level envelope encryption with per-tenant data keys (doc 16 §4), with blind-index lookups where uniqueness is checked. Planned for Phase 4 (P4-8 data protection) — acceptable for a private beta with trusted tenants and their consent |
| F2 | 🟡 Medium | Tenant users sign in with a password only. | Optional TOTP for tenant users, mandatory for owners and administrators, in Phase 4. Beta mitigation: strong password policy, lockout, short-lived tokens, owners told in onboarding |
| A1 | 🟢 Low (accepted) | `braces` ReDoS in a development dependency (lint only). | Accepted; revisit when `eslint-plugin-boundaries` updates `micromatch` |

## 4. Needs the hosted system (P0-3)

TLS configuration and HSTS through the proxy; database and object storage reachable only on the private network; firewall and SSH policy; secrets in the host's secret store with rotation; log shipping and alerts; a scan of the deployed host (e.g. OWASP ZAP baseline against staging). Repeat this review against staging before general availability.
