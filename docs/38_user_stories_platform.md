# 38 — User stories: platform side

Written for the teams building the **staff console and the reseller portal**. These stories cover how Autoforce runs the platform. What businesses do is in [37_user_stories_business.md](37_user_stories_business.md).

**Status:** all of this is built in the API as of 2026-11-04 (Phases 0–9). Hosting is not ready, so nothing here has been used on a live server yet.

**Size:** 102 stories covering 278 endpoints.

## How to read a story

Each story has an ID, a user story sentence, the surface it belongs on, acceptance criteria where the behaviour needs explaining, and the endpoints that deliver it.

- **Access** is what the server enforces: a permission key, `Signed-in`, or `Public`.
- **Returns** is the type of `data` in the response, linked to its fields in [39_api_response_shapes.md](39_api_response_shapes.md).
- **Surface** is a suggestion from the product personas, not a rule enforced by the API.
- **Stories marked "(system)"** are server to server and need no screen. They are listed so the route inventory is complete.
- Roles named in a story are the usual ones. Businesses can create custom roles, so **always gate on the permission, never on the role name**.

This document was checked against the route declarations in `src/adapters/routes`: every endpoint on this side appears in at least one story. If the two ever disagree, the code wins.

## Conventions for every screen

**Connecting**

- Base path is `/api/platform/v1`. There is no `X-Tenant` header: staff tokens are separate from tenant tokens.
- Access tokens last 10 minutes and sessions end after 60 idle minutes (defaults).
- Reseller users sign in through the same routes but reach only `/partner/*` and their own session routes. Everything they see is scoped to their partner.

**The three safety patterns**

| Pattern | How it appears | What the screen should do |
|---|---|---|
| **Step-up** | Routes marked "(step-up)" answer `403 STEP_UP_REQUIRED` | Ask for password and code, call `POST /auth/step-up`, retry the request |
| **Four-eyes** | The action creates an approval request | Show "waiting for approval", not success. Link to the approvals queue |
| **Support session** | A time-boxed tenant token, read-only by default | Show a persistent banner. Writes need a second approver |

Envelope, field errors and money format match the business side: see [conventions](37_user_stories_business.md#conventions-for-every-screen).

**Least data:** list and search screens show operational data only. Tenant business data is visible only inside a support session, and every request in that session is recorded. Do not design a console screen that assumes otherwise.

**Known gaps to plan around**

- **Use [api/openapi.json](api/openapi.json) to generate clients.** The document served by the running API has requests only. Response shapes come from the TypeScript types and were compared with responses recorded in the integration tests, which reach 696 of the 999 routes across both sides.
- Several console sections in [27_platform_admin_console.md](27_platform_admin_console.md) have no API yet: see [Not built](#not-built).

## Not built

These appear in the design docs or the permission catalogue, but have no API today. Do not design console screens for them yet.

| Area | Permission reserved | Today |
|---|---|---|
| Edit a tenant, activate one by hand | `platform.tenants.edit`, `platform.tenants.activate` | No route |
| Transfer ownership, rename a slug | `platform.tenants.transfer_ownership`, `platform.tenants.rename_slug` | No route (owner recovery is built) |
| Publish the permission catalogue | `platform.catalogue.view`, `platform.catalogue.publish` | No route |
| Restore from backup, run migrations | `platform.data.backups.restore`, `platform.data.migrations.run` | Done from the command line; the console views them only |
| Job queue, one-off scripts | `platform.data.jobs.manage`, `platform.data.scripts.run` | No route |
| Staff access review | `platform.security.access_review.view` | No route |
| Coupons, reseller onboarding view | `platform.partner.coupons.use`, `platform.partner.tenants.view_onboarding` | Capability exists; nothing uses it |
| Staff passkeys | None | Authenticator codes only |

The capabilities `view_owner_contact`, `view_billing_state`, `terms.view` and `referral_tools.view` have no route of their own: they change what the reseller routes return, so tolerate those fields being absent.

## Contents

**Part 1: Getting into the console**

- [Staff sign-in and session](#staff-sign-in-and-session)
- [Staff and roles](#staff-and-roles)
- [Four-eyes approvals](#four-eyes-approvals)
- [Audit](#audit)

**Part 2: Bringing businesses on board**

- [Application queue](#application-queue)
- [Onboarding concierge](#onboarding-concierge)
- [Demo tenants](#demo-tenants)

**Part 3: Running tenants**

- [Tenant profile](#tenant-profile)
- [Tenant branches](#tenant-branches)
- [Helping tenants](#helping-tenants)
- [Support desk](#support-desk)

**Part 4: Billing tenants**

- [Plans and subscriptions](#plans-and-subscriptions)
- [Invoices and payments](#invoices-and-payments)
- [Billing automation](#billing-automation)
- [Enterprise quotes](#enterprise-quotes)

**Part 5: Resellers**

- [Managing resellers (staff)](#managing-resellers-staff)
- [The reseller portal](#the-reseller-portal)

**Part 6: Keeping the platform healthy**

- [Health, alerts and launch](#health-alerts-and-launch)
- [Flags and modules](#flags-and-modules)
- [Backups, migrations and clusters](#backups-migrations-and-clusters)
- [Cold archive, erasure and data rights](#cold-archive-erasure-and-data-rights)
- [Enterprise services](#enterprise-services)

**Part 7: Growth analytics**

- [Analytics](#analytics)

---

# Part 1: Getting into the console

## Staff sign-in and session

Staff never self-register. There is no password-only sign-in: every account has an authenticator.

### P-AUTH-01 · Accept my staff invitation

**As a** staff member, **I want to** set my password from a one-time link **so that** I can start work.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/auth/invitations/accept` | Public | Accept a staff invitation and set the password | [PostPlatformAuthLogin](39_api_response_shapes.md#postplatformauthlogin) |

### P-AUTH-02 · Set up my authenticator

**As a** staff member, **I want to** scan a QR code and confirm a first code **so that** my account is protected.

*Surface: Console*

**Acceptance criteria**

- Sign-in answers with the next step: `enrol` or `mfa`. The secret is shown only during enrolment.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/auth/mfa/enrol` | Public | Start authenticator enrolment (returns the secret for the QR code) | [PostPlatformAuthMfaEnrol](39_api_response_shapes.md#postplatformauthmfaenrol) |
| POST | `/api/platform/v1/auth/mfa/enrol/confirm` | Public | Confirm authenticator enrolment with a first code | object / object (no envelope) |

### P-AUTH-03 · Sign in with two steps

**As a** staff member, **I want to** enter my password, then my code **so that** only I can get in.

*Surface: Console*

**Acceptance criteria**

- Step one returns `mfa` or `enrol`. Each code works once.
- Access tokens last 10 minutes by default and sessions end after 60 idle minutes.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/auth/login` | Public | Staff sign-in, step 1: email and password | [PostPlatformAuthLogin](39_api_response_shapes.md#postplatformauthlogin) |
| POST | `/api/platform/v1/auth/mfa` | Public | Staff sign-in, step 2: authenticator code | object / object (no envelope) |
| POST | `/api/platform/v1/auth/refresh` | Public | Rotate the refresh token and get a new access token | object / object (no envelope) |
| POST | `/api/platform/v1/auth/logout` | Any console user | End the current session | No body (204) |
| GET | `/api/platform/v1/me` | Any console user | The signed-in staff member, roles and permissions | [GetPlatformMe](39_api_response_shapes.md#getplatformme) |

### P-AUTH-04 · Confirm a sensitive action

**As a** staff member, **I want to** re-enter my password and code when asked **so that** dangerous actions need fresh proof.

*Surface: Console*

**Acceptance criteria**

- Routes marked "step-up" answer `403 STEP_UP_REQUIRED` without a recent step-up. Prompt, then retry the same request.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/auth/step-up` | Any console user | Re-authenticate (password + code) before sensitive actions | No body (204) |

### P-AUTH-05 · See what I may do

**As a** staff member or reseller, **I want to** have the console show only my allowed actions **so that** I am not offered what I cannot do.

*Surface: Console, Partner console*

**Acceptance criteria**

- Build navigation from the `GET /me` permissions. Reseller users reach only partner routes and their own session routes.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/me` | Any console user | The signed-in staff member, roles and permissions | [GetPlatformMe](39_api_response_shapes.md#getplatformme) |

## Staff and roles

### P-STF-01 · Manage staff

**As a** Super Admin, **I want to** invite, disable, enable and reset authenticators **so that** access follows who works here.

*Surface: Console*

**Acceptance criteria**

- Disabling ends all sessions. Reset is for a lost phone.
- Granting Super Admin needs approval. The last Super Admin cannot be removed (`LAST_SUPER_ADMIN`).

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/staff` | `platform.staff.view` | Staff accounts | [GetPlatformStaffItem](39_api_response_shapes.md#getplatformstaffitem)[] |
| POST | `/api/platform/v1/staff/invitations` | `platform.staff.manage` (step-up) | Invite a staff member (email with a one-time link) | [PostPlatformStaffInvitations](39_api_response_shapes.md#postplatformstaffinvitations) |
| POST | `/api/platform/v1/staff/:id/disable` | `platform.staff.manage` (step-up) | Disable a staff account (ends all sessions) | No body (204) |
| POST | `/api/platform/v1/staff/:id/enable` | `platform.staff.manage` (step-up) | Re-enable a staff account | No body (204) |
| POST | `/api/platform/v1/staff/:id/reset-mfa` | `platform.staff.manage` (step-up) | Reset a staff member's authenticator (lost phone) | No body (204) |
| PUT | `/api/platform/v1/staff/:id/roles` | `platform.staff.manage` (step-up) | Replace a staff member's roles (granting Super Admin needs approval) | object / object |

### P-STF-02 · Shape staff roles

**As a** Super Admin, **I want to** create and edit custom roles from the catalogue **so that** duties stay separated.

*Surface: Console*

**Acceptance criteria**

- System roles are read-only (`SYSTEM_ROLE_LOCKED`).

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/roles` | `platform.staff.view` | Staff roles with their permissions | [GetPlatformRolesItem](39_api_response_shapes.md#getplatformrolesitem)[] |
| POST | `/api/platform/v1/roles` | `platform.roles.manage` (step-up) | Create a custom staff role | [PostUsersInvitations](39_api_response_shapes.md#postusersinvitations) |
| PUT | `/api/platform/v1/roles/:id` | `platform.roles.manage` (step-up) | Edit a custom staff role (system roles are read-only) | No body (204) |
| GET | `/api/platform/v1/permissions` | `platform.staff.view` | The platform permission catalogue | [GetPlatformPermissionsItem](39_api_response_shapes.md#getplatformpermissionsitem)[] |

## Four-eyes approvals

Dangerous actions do not run at once: they become requests that another staff member approves. The console should show "waiting for approval", not success.

### P-APR-01 · Decide approval requests

**As a** Super Admin or Operations staff member, **I want to** see requests and approve or reject them **so that** no one acts alone on dangerous work.

*Surface: Console*

**Acceptance criteria**

- Nobody approves their own request (`APPROVAL_SELF`).
- Some requests need a Super Admin (`APPROVER_ROLE_REQUIRED`); a decided request answers `APPROVAL_NOT_PENDING`.
- Approving also executes the request, so show its outcome.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/approvals` | Any staff | Approval requests | [GetPlatformApprovalsItem](39_api_response_shapes.md#getplatformapprovalsitem)[] |
| POST | `/api/platform/v1/approvals/:id/approve` | `platform.approvals.approve` (step-up) | Approve (and execute) another staff member's request | [GetPlatformApprovalsItem](39_api_response_shapes.md#getplatformapprovalsitem) |
| POST | `/api/platform/v1/approvals/:id/reject` | `platform.approvals.approve` (step-up) | Reject another staff member's request | [GetPlatformApprovalsItem](39_api_response_shapes.md#getplatformapprovalsitem) |

## Audit

### P-AUD-01 · Search the audit log

**As an** Auditor (read-only) or Super Admin, **I want to** filter by actor, action, tenant, entity and date, and export **so that** every console action can be accounted for.

*Surface: Console*

**Acceptance criteria**

- CSV export is at most 10,000 rows, and the export is audited too.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/audit-logs` | `platform.security.audit.view` | Search the platform audit log (newest first) | [PlatformAuditRecord](39_api_response_shapes.md#platformauditrecord)[] |
| GET | `/api/platform/v1/audit-logs/export` | `platform.security.audit.view` | Export the platform audit log as CSV (at most 10,000 rows; the export is audited) | File |

---

# Part 2: Bringing businesses on board

## Application queue

### P-APP-01 · Work the queue

**As an** Operations staff member, Sales / Onboarding staff member or Support agent, **I want to** list applications and open one with risk signals, timeline and similar applications **so that** I can judge them fast.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/applications` | `platform.applications.view` | Applications (newest first) | [GetPlatformApplicationsItem](39_api_response_shapes.md#getplatformapplicationsitem)[] |
| GET | `/api/platform/v1/applications/:id` | `platform.applications.view` | Application with risk signals, timeline and similar applications | [ApplicationDetailView](39_api_response_shapes.md#applicationdetailview) |
| GET | `/api/platform/v1/applications/:id/documents` | `platform.applications.view` | KYC documents of an application (short-lived download links) | [PostDealerAppraisalsIdPhotosFileIdComplete](39_api_response_shapes.md#postdealerappraisalsidphotosfileidcomplete)[] |

### P-APP-02 · Sign up a client

**As a** Sales / Onboarding staff member or Operations staff member, **I want to** apply on a client's behalf **so that** they join without doing the form.

*Surface: Console*

**Acceptance criteria**

- The client still verifies their own email and phone.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/applications` | `platform.applications.create_assisted` | Assisted signup: apply on behalf of a client (they verify email and phone) | [PostApplications](39_api_response_shapes.md#postapplications) |

### P-APP-03 · Review an application

**As an** Operations staff member, **I want to** assign a reviewer and ask for more information **so that** questions reach the applicant.

*Surface: Console*

**Acceptance criteria**

- The request emails the applicant.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/applications/:id/assign` | `platform.applications.review` | Assign a reviewer (null to unassign) | No body (204) |
| POST | `/api/platform/v1/applications/:id/request-info` | `platform.applications.review` | Ask the applicant for more information (emails them) | No body (204) |

### P-APP-04 · Approve or reject

**As an** Operations staff member, **I want to** approve or reject with a reason **so that** good businesses start and bad ones do not.

*Surface: Console*

**Acceptance criteria**

- Approval starts provisioning. A rejection reason may be shown to the applicant.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/applications/:id/approve` | `platform.applications.approve` | Approve (provisioning follows in P1-3) | No body (204) |
| POST | `/api/platform/v1/applications/:id/reject` | `platform.applications.reject` | Reject (with a reason; optionally shown to the applicant) | No body (204) |

### P-APP-05 · Watch provisioning

**As an** Operations staff member, **I want to** see provisioning progress and retry a failure **so that** a new tenant is never stuck.

*Surface: Console*

**Acceptance criteria**

- Retry resumes from the failed step.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/tenants/:id/provisioning` | `platform.tenants.view` | Provisioning progress of a tenant | [GetPlatformTenantsIdProvisioning](39_api_response_shapes.md#getplatformtenantsidprovisioning) |
| POST | `/api/platform/v1/tenants/:id/provisioning/retry` | `platform.applications.approve` | Retry failed provisioning (resumes from the failed step) | No body (202) |

## Onboarding concierge

### P-ONB-01 · Follow onboarding tasks

**As a** Support agent, Operations staff member or Sales / Onboarding staff member, **I want to** see tasks across tenants, complete, skip or reopen them **so that** every new tenant gets going.

*Surface: Console*

**Acceptance criteria**

- Skipping needs a note. Milestones complete tasks on their own.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/onboarding/tasks` | `platform.support.onboarding.manage` | Concierge tasks across tenants (open and overdue first) | [GetPlatformOnboardingTasksItem](39_api_response_shapes.md#getplatformonboardingtasksitem)[] |
| GET | `/api/platform/v1/tenants/:id/onboarding-tasks` | `platform.support.onboarding.manage` | A tenant's concierge tasks | [GetPlatformOnboardingTasksItem](39_api_response_shapes.md#getplatformonboardingtasksitem)[] |
| POST | `/api/platform/v1/tenants/:id/onboarding-tasks` | `platform.support.onboarding.manage` | Add a task of your own to a tenant's list | [GetPlatformOnboardingTasksItem](39_api_response_shapes.md#getplatformonboardingtasksitem) |
| POST | `/api/platform/v1/onboarding/tasks/:id/:action` | `platform.support.onboarding.manage` | Complete, skip (with a note) or reopen a concierge task | [GetPlatformOnboardingTasksItem](39_api_response_shapes.md#getplatformonboardingtasksitem) |

### P-ONB-02 · Assign a concierge

**As a** Support agent, Operations staff member or Sales / Onboarding staff member, **I want to** give one task or a whole tenant to a staff member **so that** each tenant has a named person.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| PUT | `/api/platform/v1/onboarding/tasks/:id/assignee` | `platform.support.onboarding.manage` | Give a concierge task to a staff member | [GetPlatformOnboardingTasksItem](39_api_response_shapes.md#getplatformonboardingtasksitem) |
| PUT | `/api/platform/v1/tenants/:id/onboarding-tasks/assignee` | `platform.support.onboarding.manage` | Make a staff member the tenant's concierge: every open task goes to them | [GetPlatformOnboardingTasksItem](39_api_response_shapes.md#getplatformonboardingtasksitem)[] |

### P-ONB-03 · Keep task templates

**As an** Operations staff member, Sales / Onboarding staff member or Support agent, **I want to** see and change templates **so that** tenants from now on get the right list.

*Surface: Console*

**Acceptance criteria**

- Changes apply only to tenants provisioned from now on.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/onboarding/templates` | `platform.support.onboarding.manage` | The onboarding concierge's task templates | [GetPlatformOnboardingTemplatesItem](39_api_response_shapes.md#getplatformonboardingtemplatesitem)[] |
| PUT | `/api/platform/v1/onboarding/templates/:key` | `platform.support.settings.manage` | Add or change a task template (applies to tenants provisioned from now on) | [GetPlatformOnboardingTemplatesItem](39_api_response_shapes.md#getplatformonboardingtemplatesitem)[] |

## Demo tenants

### P-DEMO-01 · Run a demo

**As a** Sales / Onboarding staff member or Operations staff member, **I want to** create a demo with sample data, extend it or end it **so that** prospects can try the product.

*Surface: Console*

**Acceptance criteria**

- Lasts 14 days by default (1 to 90), at most 50 at a time.
- The contact receives the owner's sign-in. Demos are never invoiced and are left out of analytics.
- An ended demo is purged a week later; extending reopens it until then.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/demo-tenants` | `platform.tenants.demos.manage` | Demo and sandbox tenants with their sample data and end dates | [GetPlatformDemoTenantsItem](39_api_response_shapes.md#getplatformdemotenantsitem)[] |
| POST | `/api/platform/v1/demo-tenants` | `platform.tenants.demos.manage` | Create a demo tenant with sample data; the contact gets the owner's sign-in | [GetPlatformDemoTenantsItem](39_api_response_shapes.md#getplatformdemotenantsitem) |
| GET | `/api/platform/v1/demo-tenants/:id` | `platform.tenants.demos.manage` | A demo tenant | [GetPlatformDemoTenantsItem](39_api_response_shapes.md#getplatformdemotenantsitem) |
| POST | `/api/platform/v1/demo-tenants/:id/extend` | `platform.tenants.demos.manage` | Give a demo more days (an ended one is opened again until it is purged) | [GetPlatformDemoTenantsItem](39_api_response_shapes.md#getplatformdemotenantsitem) |
| POST | `/api/platform/v1/demo-tenants/:id/end` | `platform.tenants.demos.manage` | End a demo now (purged a week later) | [GetPlatformDemoTenantsItem](39_api_response_shapes.md#getplatformdemotenantsitem) |

---

# Part 3: Running tenants

## Tenant profile

### P-TEN-01 · See the day

**As an** Operations staff member, Support agent, Billing / Finance staff member or Sales / Onboarding staff member, **I want to** see tiles for tenants by status, waiting applications, ending trials and failures **so that** I know where to look first.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/dashboard` | `platform.dashboard.view` | Dashboard tiles: tenants by status, applications waiting, trials ending, failures | [Dashboard](39_api_response_shapes.md#dashboard) |

### P-TEN-02 · Find a tenant

**As a** Support agent, Operations staff member, Billing / Finance staff member or Sales / Onboarding staff member, **I want to** filter and search tenants, and browse by tag **so that** I can reach any account.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/tenants` | `platform.tenants.view` | Tenant list (newest first): filter by status, tag, creation date, or search | [GetPlatformTenantsItem](39_api_response_shapes.md#getplatformtenantsitem)[] |
| GET | `/api/platform/v1/tags` | `platform.tenants.view` | Tags in use, with the number of tenants for each | [GetPlatformTagsItem](39_api_response_shapes.md#getplatformtagsitem)[] |

### P-TEN-03 · Open a tenant 360

**As a** Support agent, Operations staff member, Billing / Finance staff member or Sales / Onboarding staff member, **I want to** see status, owner, provisioning, schema, backups, usage, tags and timeline **so that** I understand the account in one place.

*Surface: Console*

**Acceptance criteria**

- This view holds operational data only: tenant business data needs a support session.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/tenants/:id` | `platform.tenants.view` | Tenant 360° profile: status, owner, provisioning, schema, backups, usage, tags | [TenantProfile](39_api_response_shapes.md#tenantprofile) |
| GET | `/api/platform/v1/tenants/:id/timeline` | `platform.tenants.view` | Tenant timeline: application events and every audited console action | [GetPlatformTenantsIdTimelineItem](39_api_response_shapes.md#getplatformtenantsidtimelineitem)[] |
| GET | `/api/platform/v1/tenants/:id/status-history` | `platform.tenants.view` | Tenant status history | [GetPlatformTenantsIdStatusHistoryItem](39_api_response_shapes.md#getplatformtenantsidstatushistoryitem)[] |
| GET | `/api/platform/v1/tenants/:id/usage` | `platform.tenants.view` | A tenant's daily usage (active users, API calls, records, size) | [GetPlatformTenantsIdUsageItem](39_api_response_shapes.md#getplatformtenantsidusageitem)[] |

### P-TEN-04 · Keep notes and tags

**As a** Support agent, Operations staff member or Sales / Onboarding staff member, **I want to** add, pin and edit notes, and tag tenants **so that** colleagues have the context.

*Surface: Console*

**Acceptance criteria**

- Notes are never shown to the tenant. Only the author can edit or delete, and the audit log keeps the text.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/tenants/:id/notes` | `platform.tenants.view` | Internal notes on a tenant (newest first; `pinned=true` for pinned only) | [GetPlatformTenantsIdNotesItem](39_api_response_shapes.md#getplatformtenantsidnotesitem)[] |
| POST | `/api/platform/v1/tenants/:id/notes` | `platform.tenants.notes` | Add an internal note (never shown to the tenant) | [GetPlatformTenantsIdNotesItem](39_api_response_shapes.md#getplatformtenantsidnotesitem) |
| PATCH | `/api/platform/v1/tenants/:id/notes/:noteId` | `platform.tenants.notes` | Edit a note (author only) or pin/unpin it | [GetPlatformTenantsIdNotesItem](39_api_response_shapes.md#getplatformtenantsidnotesitem) |
| DELETE | `/api/platform/v1/tenants/:id/notes/:noteId` | `platform.tenants.notes` | Delete a note (author only; the audit log keeps its text) | No body (204) |
| PUT | `/api/platform/v1/tenants/:id/tags` | `platform.tenants.notes` | Replace a tenant's tags (e.g. vip, at-risk, partner-managed) | string[] |

### P-TEN-05 · Deactivate or restore

**As an** Operations staff member, **I want to** deactivate a tenant or restore it **so that** special cases are handled.

*Surface: Console*

**Acceptance criteria**

- Deactivation blocks every user at once. Billing normally does this automatically, so manual use is for special cases.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/tenants/:id/deactivate` | `platform.tenants.deactivate` (step-up) | Deactivate a tenant (special cases; blocks every user immediately) | No body (204) |
| POST | `/api/platform/v1/tenants/:id/restore` | `platform.tenants.restore` (step-up) | Restore a deactivated tenant to its previous status | No body (204) |

### P-TEN-06 · Make a tenant read-only

**As an** Operations staff member, **I want to** set or clear read-only mode **so that** reads work while changes stop.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/tenants/:id/read-only` | `platform.tenants.set_read_only` (step-up) | Make a tenant read-only (reads work, changes are refused) | No body (204) |
| POST | `/api/platform/v1/tenants/:id/read-only/clear` | `platform.tenants.set_read_only` (step-up) | End read-only mode | No body (204) |

## Tenant branches

### P-BRN-01 · Manage a tenant's branches

**As an** Operations staff member, **I want to** list, add and edit branches and set head office **so that** we can help with structure.

*Surface: Console*

**Acceptance criteria**

- Show the price impact first; adding beyond the subscription needs confirming it.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/tenants/:id/branches` | `platform.branches.view` | Branches of a tenant | [GetPlatformTenantsIdBranchesItem](39_api_response_shapes.md#getplatformtenantsidbranchesitem)[] |
| GET | `/api/platform/v1/tenants/:id/branches/price-impact` | `platform.branches.view` | What one more active branch would cost the tenant (before adding or reactivating) | [GetPlatformTenantsIdBranchesPriceImpact](39_api_response_shapes.md#getplatformtenantsidbranchespriceimpact) |
| POST | `/api/platform/v1/tenants/:id/branches` | `platform.branches.manage` | Add a branch for a tenant (beyond its subscription: confirm the price impact) | [PostUsersInvitations](39_api_response_shapes.md#postusersinvitations) |
| PATCH | `/api/platform/v1/tenants/:id/branches/:branchId` | `platform.branches.manage` | Edit a tenant's branch | No body (204) |
| POST | `/api/platform/v1/tenants/:id/branches/:branchId/make-default` | `platform.branches.manage` | Make a tenant's branch the default (head office) | No body (204) |

### P-BRN-02 · Close a tenant's branch

**As an** Operations staff member, **I want to** check, reassign, deactivate, reactivate or remove a branch **so that** nothing is stranded.

*Surface: Console*

**Acceptance criteria**

- Removal works only for a branch with no records.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/tenants/:id/branches/:branchId/deactivation-check` | `platform.branches.view` | What is still live in a tenant's branch and what blocks deactivating it | [GetPlatformTenantsIdBranchesBranchIdDeactivationCheck](39_api_response_shapes.md#getplatformtenantsidbranchesbranchiddeactivationcheck) |
| POST | `/api/platform/v1/tenants/:id/branches/:branchId/reassign` | `platform.branches.manage` | Move everything live in a tenant's branch to another branch (deactivation wizard) | [BranchMove](39_api_response_shapes.md#branchmove) |
| POST | `/api/platform/v1/tenants/:id/branches/:branchId/deactivate` | `platform.branches.manage` | Deactivate a tenant's branch | No body (204) |
| POST | `/api/platform/v1/tenants/:id/branches/:branchId/reactivate` | `platform.branches.manage` | Reactivate a tenant's branch | No body (204) |
| POST | `/api/platform/v1/tenants/:id/branches/:branchId/remove` | `platform.branches.manage` | Remove (no records only) a tenant's branch | No body (204) |

### P-BRN-03 · Fix branch billing drift

**As an** Operations staff member or Billing / Finance staff member, **I want to** compare billed and active branches and see over-limit tenants **so that** billing matches reality.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/tenants/:id/branches/reconcile` | `platform.branches.manage` | Compare the billed branches with the tenant's active branches and fix drift | [PostPlatformTenantsIdBranchesReconcile](39_api_response_shapes.md#postplatformtenantsidbranchesreconcile) |
| GET | `/api/platform/v1/billing/branch-reconciliations` | `platform.billing.view` | Branch reconciliations (filter: tenant, outcome such as over_limit or fixed) | [PostPlatformTenantsIdBranchesReconcile](39_api_response_shapes.md#postplatformtenantsidbranchesreconcile)[] |
| GET | `/api/platform/v1/billing/over-limit` | `platform.billing.view` | Tenants with more active branches than they pay for | [GetPlatformBillingOverLimitItem](39_api_response_shapes.md#getplatformbillingoverlimititem)[] |

### P-BRN-04 · Override the branch limit

**As an** Operations staff member, **I want to** allow more active branches than billed **so that** a special deal can be honoured.

*Surface: Console*

**Acceptance criteria**

- `null` removes the override.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| PUT | `/api/platform/v1/tenants/:id/entitlements/branches` | `platform.entitlements.override` (step-up) | Allow more active branches than billed (null removes the override) | [GetBillingSubscription](39_api_response_shapes.md#getbillingsubscription) |

## Helping tenants

### P-SUP-01 · Find a person

**As a** Support agent or Operations staff member, **I want to** find someone across tenants by email or phone, and list a tenant's users **so that** I can place a caller.

*Surface: Console*

**Acceptance criteria**

- Shows status, lockout and last sign-in, never business data.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/users/search` | `platform.users.search` | Find a person across tenants by email or phone | [GetPlatformUsersSearchItem](39_api_response_shapes.md#getplatformuserssearchitem)[] |
| GET | `/api/platform/v1/tenants/:id/users` | `platform.users.search` | A tenant's users (status, lockout, last sign-in; no business data) | [GetPlatformTenantsIdUsersItem](39_api_response_shapes.md#getplatformtenantsidusersitem)[] |

### P-SUP-02 · Help a user get back in

**As a** Support agent, **I want to** reset a password, unlock, force logout, disable or enable **so that** I can solve access calls.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/tenants/:id/users/:userId/:action` | `platform.users.reset_access` (step-up) | Help a user: reset-password (emails a code), unlock, force-logout, disable, enable | [GetPlatformTenantsIdUsersItem](39_api_response_shapes.md#getplatformtenantsidusersitem) |

### P-SUP-03 · Recover an owner

**As an** Operations staff member, **I want to** set a new sign-in email after identity checks **so that** a locked-out owner gets their business back.

*Surface: Console*

**Acceptance criteria**

- A Super Admin approves.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/tenants/:id/owner-recovery` | `platform.users.recover_owner` (step-up) | Owner recovery: a new sign-in email after identity checks (Super Admin approves) | [PostPlatformTenantsIdColdArchive](39_api_response_shapes.md#postplatformtenantsidcoldarchive) |

### P-SUP-04 · Open a tenant in support mode

**As a** Support agent or Operations staff member, **I want to** open a time-boxed session and get a tenant token **so that** I can see what the customer sees.

*Surface: Console*

**Acceptance criteria**

- Read-only by default; write mode waits for a second approver.
- Sensitive values are masked. Some actions are always blocked (`SUPPORT_ACTION_BLOCKED`), and writes in read mode give `SUPPORT_READ_ONLY`.
- Show a persistent banner while the session runs. Two hours in all at most.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/tenants/:id/support-sessions` | `platform.support.access_tenant` | Open a tenant in support mode (read-only; write mode waits for a second approver) | [PostPlatformTenantsIdSupportSessions](39_api_response_shapes.md#postplatformtenantsidsupportsessions) |
| POST | `/api/platform/v1/support-sessions/:id/token` | `platform.support.access_tenant` | A tenant token for your support session (starts its clock) | [PostPlatformSupportSessionsIdToken](39_api_response_shapes.md#postplatformsupportsessionsidtoken) |
| POST | `/api/platform/v1/support-sessions/:id/extend` | `platform.support.access_tenant` | More time for your session (two hours in all at most) | [PostPlatformTenantsIdSupportSessions](39_api_response_shapes.md#postplatformtenantsidsupportsessions) |
| POST | `/api/platform/v1/support-sessions/:id/end` | `platform.support.access_tenant` | End your support session | [PostPlatformTenantsIdSupportSessions](39_api_response_shapes.md#postplatformtenantsidsupportsessions) |

### P-SUP-05 · Review support sessions

**As an** Auditor (read-only), Support agent or Operations staff member, **I want to** list sessions and every request made in them **so that** access to customers is accountable.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/support-sessions` | `platform.support.sessions.view` | Support sessions, by staff member or tenant | [SupportSessionRow](39_api_response_shapes.md#supportsessionrow)[] |
| GET | `/api/platform/v1/support-sessions/:id` | `platform.support.sessions.view` | A support session with every request made in it | [GetPlatformSupportSessionsId](39_api_response_shapes.md#getplatformsupportsessionsid) |

## Support desk

### P-DSK-01 · Work the ticket queue

**As a** Support agent, Operations staff member, on-call engineer or Auditor (read-only), **I want to** see tickets, most urgent first, and a summary **so that** the worst problems come first.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/support/tickets` | `platform.support.tickets.view` | Support tickets, active and most urgent first | [TicketView](39_api_response_shapes.md#ticketview)[] |
| GET | `/api/platform/v1/support/tickets/:id` | `platform.support.tickets.view` | A ticket with its conversation and internal notes | [PostSupportTickets](39_api_response_shapes.md#postsupporttickets) |
| GET | `/api/platform/v1/support/summary` | `platform.support.tickets.view` | Support at a glance: active, breached, and the period's SLA and satisfaction | [GetPlatformSupportSummary](39_api_response_shapes.md#getplatformsupportsummary) |

### P-DSK-02 · Log a ticket

**As a** Support agent or on-call engineer, **I want to** record a call, email or WhatsApp message **so that** every request is tracked.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/support/tickets` | `platform.support.tickets.manage` | Log a ticket from a call, an email or a WhatsApp message | [TicketView](39_api_response_shapes.md#ticketview) |

### P-DSK-03 · Handle a ticket

**As a** Support agent or on-call engineer, **I want to** change priority, reply or add notes, and resolve or close **so that** customers get answers.

*Surface: Console*

**Acceptance criteria**

- Replies are emailed; internal notes are hidden from the requester.
- Resolving asks the requester for a rating. Waiting tickets resolve after 7 days and resolved ones close after 7 days.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| PATCH | `/api/platform/v1/support/tickets/:id` | `platform.support.tickets.manage` | Change a ticket's priority, category or assignee; link its tenant or request | [TicketView](39_api_response_shapes.md#ticketview) |
| POST | `/api/platform/v1/support/tickets/:id/messages` | `platform.support.tickets.manage` | Reply to the requester (emailed) or add an internal note; a canned response fills in | [PostSupportTickets](39_api_response_shapes.md#postsupporttickets) |
| POST | `/api/platform/v1/support/tickets/:id/status` | `platform.support.tickets.manage` | Open a ticket again, resolve it (the requester is asked to rate it) or close it | [TicketView](39_api_response_shapes.md#ticketview) |

### P-DSK-04 · Escalate to engineering

**As a** Support agent or on-call engineer, **I want to** escalate with the request id, Sentry link and note **so that** engineers can find the fault.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/support/tickets/:id/escalate` | `platform.support.tickets.manage` | Escalate to engineering with the request id and the Sentry link | [TicketView](39_api_response_shapes.md#ticketview) |

### P-DSK-05 · Use canned responses

**As a** Support agent, **I want to** write and retire templates **so that** common answers are quick.

*Surface: Console*

**Acceptance criteria**

- Placeholders: `{{requesterName}}`, `{{ticketNumber}}`, `{{staffName}}`, `{{businessName}}`.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/support/canned-responses` | `platform.support.tickets.view` | Canned responses, most used first | [GetPlatformSupportCannedResponsesItem](39_api_response_shapes.md#getplatformsupportcannedresponsesitem)[] |
| POST | `/api/platform/v1/support/canned-responses` | `platform.support.canned_responses.manage` | Write a canned response ({{requesterName}}, {{ticketNumber}}, {{staffName}}, {{businessName}}) | [GetPlatformSupportCannedResponsesItem](39_api_response_shapes.md#getplatformsupportcannedresponsesitem) |
| PUT | `/api/platform/v1/support/canned-responses/:id` | `platform.support.canned_responses.manage` | Change or retire a canned response | [GetPlatformSupportCannedResponsesItem](39_api_response_shapes.md#getplatformsupportcannedresponsesitem) |

### P-DSK-06 · Set SLA targets

**As an** Operations staff member, **I want to** see and set targets per priority **so that** service levels are clear.

*Surface: Console*

**Acceptance criteria**

- Applies to tickets raised from now on. Counted in support hours except urgent.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/support/sla` | `platform.support.tickets.view` | The SLA targets per priority (minutes; in support hours unless around the clock) | [GetPlatformSupportSla](39_api_response_shapes.md#getplatformsupportsla) |
| PUT | `/api/platform/v1/support/sla/:priority` | `platform.support.settings.manage` | Set a priority's targets (for tickets raised from now on) | [GetPlatformSupportSla](39_api_response_shapes.md#getplatformsupportsla) |

---

# Part 4: Billing tenants

## Plans and subscriptions

### P-PLN-01 · Set prices

**As a** Billing / Finance staff member, **I want to** see plans and set the standard price per branch **so that** invoicing can run.

*Surface: Console*

**Acceptance criteria**

- Applies to the next invoices.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/billing/plans` | `platform.billing.view` | Plans and prices | [GetPlatformBillingPlansItem](39_api_response_shapes.md#getplatformbillingplansitem)[] |
| PUT | `/api/platform/v1/billing/plans/:code/price` | `platform.billing.prices.manage` (step-up) | Set the standard price per branch per month (applies to the next invoices) | [GetPlatformBillingPlansItem](39_api_response_shapes.md#getplatformbillingplansitem) |

### P-PLN-02 · Set seller details

**As a** Billing / Finance staff member, **I want to** keep Autoforce's details, VAT and payment instructions **so that** invoices are legal.

*Surface: Console*

**Acceptance criteria**

- Applies to new invoices.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/billing/settings` | `platform.billing.view` | Autoforce as the seller on invoices, VAT and payment instructions | [GetPlatformBillingSettings](39_api_response_shapes.md#getplatformbillingsettings) |
| PUT | `/api/platform/v1/billing/settings` | `platform.billing.prices.manage` (step-up) | Change the seller details, VAT registration and rates (applies to new invoices) | [GetPlatformBillingSettings](39_api_response_shapes.md#getplatformbillingsettings) |

### P-PLN-03 · See a tenant's subscription

**As a** Billing / Finance staff member or Operations staff member, **I want to** see subscription, entitlements, billing events and details **so that** I can answer billing questions.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/tenants/:id/subscription` | `platform.billing.view` | A tenant's subscription, entitlements and billing events | [GetPlatformTenantsIdSubscription](39_api_response_shapes.md#getplatformtenantsidsubscription) |
| GET | `/api/platform/v1/tenants/:id/billing-details` | `platform.billing.view` | A tenant's billing details and contacts | [GetBillingDetails](39_api_response_shapes.md#getbillingdetails) |
| GET | `/api/platform/v1/tenants/:id/billing/notices` | `platform.billing.view` | Billing notices sent to a tenant (timeline) | [GetBillingNoticesItem](39_api_response_shapes.md#getbillingnoticesitem)[] |

### P-PLN-04 · Set the licence type

**As an** Operations staff member, **I want to** choose Standard or Enterprise **so that** pricing fits the tenant.

*Surface: Console*

**Acceptance criteria**

- Only until the first payment.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| PUT | `/api/platform/v1/tenants/:id/licence-type` | `platform.tenants.set_licence_type` | Standard or Enterprise licence (only until the first payment) | [GetBillingSubscription](39_api_response_shapes.md#getbillingsubscription) |

### P-PLN-05 · Adjust a subscription

**As a** Billing / Finance staff member, **I want to** extend a trial and set billed branches **so that** exceptions are handled.

*Surface: Console*

**Acceptance criteria**

- A trial can be extended to at most 60 days from today.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/tenants/:id/subscription/extend-trial` | `platform.billing.manage` | Extend a trial (at most 60 days from today) | [GetBillingSubscription](39_api_response_shapes.md#getbillingsubscription) |
| PUT | `/api/platform/v1/tenants/:id/subscription/branches` | `platform.billing.manage` | Set the billed branch count (the branch entitlement out of trial) | [GetBillingSubscription](39_api_response_shapes.md#getbillingsubscription) |

## Invoices and payments

### P-INV-01 · Find invoices

**As a** Billing / Finance staff member or Operations staff member, **I want to** list invoices and download PDFs **so that** I can answer any query.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/billing/invoices` | `platform.billing.view` | Invoices (newest first) | [InvoiceView](39_api_response_shapes.md#invoiceview)[] |
| GET | `/api/platform/v1/billing/invoices/:id` | `platform.billing.view` | An invoice with its payments | [InvoiceView](39_api_response_shapes.md#invoiceview) |
| GET | `/api/platform/v1/billing/invoices/:id/pdf` | `platform.billing.view` | An invoice as a PDF | File |
| GET | `/api/platform/v1/billing/payments/:id/receipt/pdf` | `platform.billing.view` | The receipt of a payment as a PDF | File |

### P-INV-02 · Issue or void an invoice

**As a** Billing / Finance staff member, **I want to** issue the next period's invoice or void an unpaid one **so that** billing is correct.

*Surface: Console*

**Acceptance criteria**

- For Enterprise, enter the lines.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/tenants/:id/invoices` | `platform.billing.manage` | Issue the invoice for the next period (enterprise: enter the lines) | [InvoiceView](39_api_response_shapes.md#invoiceview) |
| POST | `/api/platform/v1/billing/invoices/:id/void` | `platform.billing.manage` | Void an unpaid invoice | [InvoiceView](39_api_response_shapes.md#invoiceview) |

### P-INV-03 · Record a manual payment

**As a** Billing / Finance staff member, **I want to** record bank transfer, MoMo, cash or cheque **so that** offline payers are credited.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/billing/invoices/:id/payments` | `platform.billing.payments.record` | Record a payment received (bank transfer, MoMo, cash, cheque) | [InvoiceView](39_api_response_shapes.md#invoiceview) |

### P-INV-04 · Refund a payment

**As a** Billing / Finance staff member, **I want to** refund through the gateway or record money paid back **so that** mistakes are put right.

*Surface: Console*

**Acceptance criteria**

- Large refunds need a second approver.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/billing/payments/:id/refunds` | `platform.billing.refunds.issue` (step-up) | Refund a payment (through the gateway, or recorded as paid back outside) | object / object |
| GET | `/api/platform/v1/billing/payments/:id/refunds` | `platform.billing.view` | Refunds of a payment | [GetPlatformBillingPaymentsIdRefundsItem](39_api_response_shapes.md#getplatformbillingpaymentsidrefundsitem)[] |

### P-INV-05 · Handle failed payments

**As a** Billing / Finance staff member or Operations staff member, **I want to** see the failed-payments queue **so that** payments needing a person are not lost.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/billing/gateway-transactions` | `platform.billing.view` | Gateway payments (status=failed: the failed-payments queue; review: needs a person) | [PostBillingInvoicesIdCheckout](39_api_response_shapes.md#postbillinginvoicesidcheckout)[] |

### P-INV-06 · Inspect gateway webhooks

**As a** Billing / Finance staff member, **I want to** see what the provider sent and replay it **so that** lost events are recovered.

*Surface: Console*

**Acceptance criteria**

- Replay is idempotent.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/billing/webhooks` | `platform.billing.view` | Webhook inspector: what the provider sent and what we did with it | [GetPlatformBillingWebhooksItem](39_api_response_shapes.md#getplatformbillingwebhooksitem)[] |
| GET | `/api/platform/v1/billing/webhooks/:id` | `platform.billing.view` | One webhook event with its payload | [GetPlatformBillingWebhooksItem](39_api_response_shapes.md#getplatformbillingwebhooksitem) |
| POST | `/api/platform/v1/billing/webhooks/:id/replay` | `platform.billing.manage` | Process a signed webhook again (idempotent) | [GetPlatformBillingWebhooksItem](39_api_response_shapes.md#getplatformbillingwebhooksitem) |

### P-INV-07 · Reconcile with the provider

**As a** Billing / Finance staff member, **I want to** see daily reconciliations and redo a day **so that** our records match the gateway.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/billing/reconciliations` | `platform.billing.view` | Daily reconciliations with the payment provider (newest first) | [GetPlatformBillingReconciliationsItem](39_api_response_shapes.md#getplatformbillingreconciliationsitem)[] |
| POST | `/api/platform/v1/billing/reconciliations` | `platform.billing.manage` | Reconcile one day again | [GetPlatformBillingReconciliationsItem](39_api_response_shapes.md#getplatformbillingreconciliationsitem) |

## Billing automation

### P-DUN-01 · Set the schedule and safeguards

**As a** Billing / Finance staff member or Operations staff member, **I want to** see and change the dunning policy **so that** reminders and deactivation are fair.

*Surface: Console*

**Acceptance criteria**

- A change creates a new version; past versions are kept.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/billing/dunning-policy` | `platform.billing.view` | The billing automation schedule and safeguards in force, with past versions | [GetPlatformBillingDunningPolicy](39_api_response_shapes.md#getplatformbillingdunningpolicy) |
| PUT | `/api/platform/v1/billing/dunning-policy` | `platform.billing.prices.manage` (step-up) | Change the schedule and safeguards (a new version) | [PutPlatformBillingDunningPolicy](39_api_response_shapes.md#putplatformbillingdunningpolicy) |

### P-DUN-02 · Review what automation will do

**As a** Billing / Finance staff member or Operations staff member, **I want to** see tenants due for deactivation in 48 hours, runs and the dry-run review **so that** nobody is cut off by mistake.

*Surface: Console*

**Acceptance criteria**

- Large tenants are flagged.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/billing/automation/pending` | `platform.billing.view` | Tenants the automation will deactivate in the next 48 hours (large ones flagged) | [PendingDeactivation](39_api_response_shapes.md#pendingdeactivation)[] |
| GET | `/api/platform/v1/billing/automation/runs` | `platform.billing.view` | Runs of the billing automation: what it did, would have done, held back | [GetPlatformBillingAutomationRunsItem](39_api_response_shapes.md#getplatformbillingautomationrunsitem)[] |
| POST | `/api/platform/v1/billing/automation/runs` | `platform.billing.manage` | Run the billing automation now | [GetPlatformBillingAutomationRunsItem](39_api_response_shapes.md#getplatformbillingautomationrunsitem) |
| GET | `/api/platform/v1/billing/automation/dry-run-review` | `platform.billing.view` | What the automation would have done in dry run, and who paid afterwards | [GetPlatformBillingAutomationDryRunReview](39_api_response_shapes.md#getplatformbillingautomationdryrunreview) |

### P-DUN-03 · Decide extensions

**As a** Billing / Finance staff member or Operations staff member, **I want to** approve or deny extension requests **so that** tenants who need time can get it.

*Surface: Console*

**Acceptance criteria**

- Approval can set another date and restores a billing deactivation.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/billing/extensions` | `platform.billing.view` | Extension requests (filter by status, e.g. requested) | [GetBillingExtensionsItem](39_api_response_shapes.md#getbillingextensionsitem)[] |
| PUT | `/api/platform/v1/billing/extensions/:id/approve` | `platform.billing.extensions.grant` | Approve an extension (optionally to another date); restores a billing deactivation | [GetBillingExtensionsItem](39_api_response_shapes.md#getbillingextensionsitem) |
| PUT | `/api/platform/v1/billing/extensions/:id/deny` | `platform.billing.extensions.grant` | Deny an extension request | [GetBillingExtensionsItem](39_api_response_shapes.md#getbillingextensionsitem) |

### P-DUN-04 · Hold for a dispute

**As a** Billing / Finance staff member, **I want to** hold or release automatic deactivation **so that** a disputed tenant is not cut off.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| PUT | `/api/platform/v1/tenants/:id/billing/dispute-hold` | `platform.billing.manage` | Hold (or release) automatic deactivation for a billing dispute or pending refund | No body (204) |

## Enterprise quotes

### P-QTE-01 · Build a quote

**As a** Billing / Finance staff member, **I want to** start and edit versioned quotes for an Enterprise tenant **so that** pricing fits them.

*Surface: Console*

**Acceptance criteria**

- Drafts are watermarked in the PDF.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/tenants/:id/quotes` | `platform.billing.view` | A tenant's Enterprise quotes, every version | [QuoteView2](39_api_response_shapes.md#quoteview2)[] |
| POST | `/api/platform/v1/tenants/:id/quotes` | `platform.billing.manage` | Start a quote (a new version) for an Enterprise tenant | [QuoteView2](39_api_response_shapes.md#quoteview2) |
| GET | `/api/platform/v1/billing/quotes/:id` | `platform.billing.view` | One quote | [QuoteView2](39_api_response_shapes.md#quoteview2) |
| GET | `/api/platform/v1/billing/quotes/:id/pdf` | `platform.billing.view` | A quote as a PDF (drafts are watermarked) | File |
| PUT | `/api/platform/v1/billing/quotes/:id` | `platform.billing.manage` | Edit a draft quote (lines, size, notes, valid until) | [QuoteView2](39_api_response_shapes.md#quoteview2) |
| GET | `/api/platform/v1/tenants/:id/price-items` | `platform.billing.view` | A tenant's price list from its accepted quote | [PriceItem](39_api_response_shapes.md#priceitem)[] |

### P-QTE-02 · Send and close a quote

**As a** Billing / Finance staff member or Super Admin, **I want to** approve and send, record acceptance, or withdraw **so that** the deal is on record.

*Surface: Console*

**Acceptance criteria**

- Approving and sending needs a Super Admin.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/billing/quotes/:id/send` | `platform.billing.manage` | Approve and send a quote to the tenant (Super Admin) | [QuoteView2](39_api_response_shapes.md#quoteview2) |
| POST | `/api/platform/v1/billing/quotes/:id/accept` | `platform.billing.manage` | Record that the tenant accepted a sent quote | [QuoteView2](39_api_response_shapes.md#quoteview2) |
| POST | `/api/platform/v1/billing/quotes/:id/withdraw` | `platform.billing.manage` | Withdraw a draft or sent quote | [QuoteView2](39_api_response_shapes.md#quoteview2) |

---

# Part 5: Resellers

## Managing resellers (staff)

### P-PTN-01 · Manage partners

**As a** Sales / Onboarding staff member or Super Admin, **I want to** list, create and edit partners, and invite their users **so that** resellers can work with us.

*Surface: Console*

**Acceptance criteria**

- A referral code is generated unless given. Partner users must enrol MFA.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/partners` | `platform.partners.view` | Partners (newest first) | [GetPlatformPartnersItem](39_api_response_shapes.md#getplatformpartnersitem)[] |
| POST | `/api/platform/v1/partners` | `platform.partners.manage` | Create a partner (default capabilities; referral code generated unless given) | [PartnerDetail](39_api_response_shapes.md#partnerdetail) |
| GET | `/api/platform/v1/partners/:id` | `platform.partners.view` | Partner profile, capabilities and console users | [PartnerDetail](39_api_response_shapes.md#partnerdetail) |
| PATCH | `/api/platform/v1/partners/:id` | `platform.partners.manage` | Edit a partner's profile, referral code or trusted flag | [PartnerDetail](39_api_response_shapes.md#partnerdetail) |
| POST | `/api/platform/v1/partners/:id/users/invitations` | `platform.partners.manage` | Invite a console user for the partner (emailed link; MFA enrolment required) | [PostPlatformPartnersIdUsersInvitations](39_api_response_shapes.md#postplatformpartnersidusersinvitations) |
| GET | `/api/platform/v1/partners/:id/tenants` | `platform.partners.view` | Tenants attributed to a partner | [GetPlatformPartnersIdTenantsItem](39_api_response_shapes.md#getplatformpartnersidtenantsitem)[] |

### P-PTN-02 · Set capabilities

**As a** Super Admin, **I want to** choose what a partner's users may see and do **so that** access is deliberate.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| PUT | `/api/platform/v1/partners/:id/capabilities` | `platform.partners.permissions.grant` (step-up) | Set what the partner's users may see and do (docs/29 §7) | [PartnerDetail](39_api_response_shapes.md#partnerdetail) |

### P-PTN-03 · Pause, resume or terminate

**As a** Sales / Onboarding staff member or Super Admin, **I want to** change a partner's standing **so that** a problem partner is stopped.

*Surface: Console*

**Acceptance criteria**

- Pausing stops new clients only. Termination is final, disables users, and attributed tenants keep the partner.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/partners/:id/pause` | `platform.partners.manage` | Pause a partner (no new clients; tenants and access stay) | No body (204) |
| POST | `/api/platform/v1/partners/:id/resume` | `platform.partners.manage` | Resume a paused partner | No body (204) |
| POST | `/api/platform/v1/partners/:id/terminate` | `platform.partners.terminate` (step-up) | Terminate a partner (final; users disabled, attributed tenants keep the partner) | No body (204) |

### P-PTN-04 · Attribute a tenant

**As a** Super Admin, **I want to** assign, change or remove a tenant's partner **so that** commission goes to the right reseller.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| PUT | `/api/platform/v1/tenants/:id/partner` | `platform.partners.attribution.manage` (step-up) | Assign, change or remove the partner a tenant is attributed to | No body (204) |

### P-PTN-05 · Keep partner documents

**As a** Sales / Onboarding staff member or Super Admin, **I want to** attach, see and remove KYC and signed agreements **so that** we hold proof.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/partners/:id/documents` | `platform.partners.manage` | Attach a document to a partner (KYC, signed agreement) | object / object (no envelope) |
| POST | `/api/platform/v1/partners/:id/documents/:fileId/complete` | `platform.partners.manage` | Confirm a partner document upload | object / object (no envelope) |
| GET | `/api/platform/v1/partners/:id/documents` | `platform.partners.view` | A partner's documents (short-lived download links) | [PostDealerAppraisalsIdPhotosFileIdComplete](39_api_response_shapes.md#postdealerappraisalsidphotosfileidcomplete)[] |
| DELETE | `/api/platform/v1/partners/:id/documents/:fileId` | `platform.partners.manage` | Remove a partner document | No body (204) |

### P-PTN-06 · Set commission terms

**As a** Super Admin, **I want to** set versioned terms and per-tenant overrides **so that** resellers are paid as agreed.

*Surface: Console*

**Acceptance criteria**

- A new version is never retroactive.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/partners/:id/commission-terms` | `platform.partners.view` | A reseller's commission terms in force, with every version | [GetPlatformPartnersIdCommissionTerms](39_api_response_shapes.md#getplatformpartnersidcommissionterms) |
| PUT | `/api/platform/v1/partners/:id/commission-terms` | `platform.partners.commission_terms.manage` (step-up) | Set a reseller's commission terms (a new version; never retroactive) | [CommissionTerms](39_api_response_shapes.md#commissionterms) |
| PUT | `/api/platform/v1/tenants/:id/partner-terms` | `platform.partners.commission_terms.manage` (step-up) | A different commission percentage for one tenant (null removes it) | No body (204) |

### P-PTN-07 · See what is owed

**As a** Billing / Finance staff member or Super Admin, **I want to** see payable commission, ledgers, statements and liability **so that** payouts are correct.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/partners/commissions/payable` | `platform.partners.view` | Commissions payable now, per reseller (with cash payouts awaiting approval) | [GetPlatformPartnersCommissionsPayableItem](39_api_response_shapes.md#getplatformpartnerscommissionspayableitem)[] |
| GET | `/api/platform/v1/partners/reports/liability` | `platform.partners.reports.view` | What Autoforce owes resellers: accrued, payable and awaiting approval | [GetPlatformPartnersCommissionsPayableItem](39_api_response_shapes.md#getplatformpartnerscommissionspayableitem)[] |
| GET | `/api/platform/v1/partners/:id/commissions` | `platform.partners.view` | A reseller's commission ledger (newest first) | [GetPlatformPartnersIdCommissionsItem](39_api_response_shapes.md#getplatformpartnersidcommissionsitem)[] |
| GET | `/api/platform/v1/partners/:id/statements/:period` | `platform.partners.view` | A reseller's monthly commission statement (YYYY-MM) | [GetPlatformPartnersIdStatementsPeriod](39_api_response_shapes.md#getplatformpartnersidstatementsperiod) |
| GET | `/api/platform/v1/partners/:id/statements/:period/pdf` | `platform.partners.view` | A reseller's monthly commission statement as a PDF | File |
| GET | `/api/platform/v1/partners/:id/statements/:period/csv` | `platform.partners.view` | A reseller's monthly commission statement as CSV | File |

### P-PTN-08 · Adjust a balance

**As a** Super Admin, **I want to** credit or debit a reseller's balance **so that** corrections are on record.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/partners/:id/adjustments` | `platform.partners.adjust` (step-up) | Credit (+) or debit (−) a reseller's commission balance | [GetPlatformPartnersIdCommissionsItem](39_api_response_shapes.md#getplatformpartnersidcommissionsitem) |

### P-PTN-09 · Pay a reseller

**As a** Billing / Finance staff member or Super Admin, **I want to** record, approve and reverse payouts **so that** commission is settled.

*Surface: Console*

**Acceptance criteria**

- A payout settles everything payable. Cash always waits for a second approver.
- Reversing makes its commissions payable again.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/partners/:id/payouts` | `platform.partners.view` | A reseller's payouts (newest first) | [GetPlatformPartnersIdPayoutsItem](39_api_response_shapes.md#getplatformpartnersidpayoutsitem)[] |
| POST | `/api/platform/v1/partners/:id/payouts` | `platform.partners.commissions.pay` | Record a payout settling everything payable (cash waits for a second approver) | [PayoutView2](39_api_response_shapes.md#payoutview2) |
| GET | `/api/platform/v1/partner-payouts` | `platform.partners.view` | Payouts across resellers (cash awaiting approval, or not yet acknowledged) | [GetPlatformPartnersIdPayoutsItem](39_api_response_shapes.md#getplatformpartnersidpayoutsitem)[] |
| GET | `/api/platform/v1/partner-payouts/:id` | `platform.partners.view` | A payout with the entries it settles | [PayoutView2](39_api_response_shapes.md#payoutview2) |
| POST | `/api/platform/v1/partner-payouts/:id/approve` | `platform.partners.commissions.pay` | Approve a cash payout as the second staff member | [PayoutView2](39_api_response_shapes.md#payoutview2) |
| POST | `/api/platform/v1/partner-payouts/:id/reverse` | `platform.partners.commissions.pay` | Reverse a payout (its commissions become payable again) | [PayoutView2](39_api_response_shapes.md#payoutview2) |

## The reseller portal

Data is always scoped to the partner on the token. Each action depends on a capability granted to that partner, so hide what is missing from the profile.

### P-RES-01 · See my dashboard and profile

**As a** reseller, **I want to** see my tenants, applications, capabilities and referral link **so that** I know how I am doing.

*Surface: Partner console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/partner/dashboard` | `platform.partner.tenants.view` | Your tenants and applications at a glance | [GetPlatformPartnerDashboard](39_api_response_shapes.md#getplatformpartnerdashboard) |
| GET | `/api/platform/v1/partner/profile` | Any partner user | Your partner profile, capabilities and referral link | [GetPlatformPartnerProfile](39_api_response_shapes.md#getplatformpartnerprofile) |

### P-RES-02 · See my businesses

**As a** reseller, **I want to** list and open the businesses I brought **so that** I can follow them up.

*Surface: Partner console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/partner/tenants` | `platform.partner.tenants.view` | Businesses you brought on board | [GetPlatformPartnerTenantsItem](39_api_response_shapes.md#getplatformpartnertenantsitem)[] |
| GET | `/api/platform/v1/partner/tenants/:id` | `platform.partner.tenants.view` | One of your businesses, with its status history | [GetPlatformPartnerTenantsId](39_api_response_shapes.md#getplatformpartnertenantsid) |

### P-RES-03 · Sign up a client

**As a** reseller, **I want to** apply for a client and answer questions **so that** they get on board.

*Surface: Partner console*

**Acceptance criteria**

- The client verifies their own email and phone.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/partner/applications` | `platform.partner.tenants.view` | Applications for your clients | [GetPlatformPartnerApplicationsItem](39_api_response_shapes.md#getplatformpartnerapplicationsitem)[] |
| GET | `/api/platform/v1/partner/applications/:id` | `platform.partner.tenants.view` | One application with the messages exchanged | [PartnerApplicationView](39_api_response_shapes.md#partnerapplicationview) |
| POST | `/api/platform/v1/partner/applications` | `platform.partner.applications.create` | Sign up a new client (they verify their email and phone) | [PostPlatformPartnerApplications](39_api_response_shapes.md#postplatformpartnerapplications) |
| POST | `/api/platform/v1/partner/applications/:id/respond` | `platform.partner.applications.respond` | Answer an information request for your client | [PartnerApplicationView](39_api_response_shapes.md#partnerapplicationview) |

### P-RES-04 · See my commission

**As a** reseller, **I want to** see my ledger, balance and statements **so that** I know what I am owed.

*Surface: Partner console*

**Acceptance criteria**

- CSV export needs `platform.partner.export`, which is not a default capability.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/partner/commissions` | `platform.partner.commissions.view` | Your commission ledger (newest first) | [GetPlatformPartnersIdCommissionsItem](39_api_response_shapes.md#getplatformpartnersidcommissionsitem)[] |
| GET | `/api/platform/v1/partner/commissions/balance` | `platform.partner.commissions.view` | What is payable to you now, waiting for its hold, or awaiting approval | object / null |
| GET | `/api/platform/v1/partner/commissions/statements/:period` | `platform.partner.commissions.view` | Your monthly statement (YYYY-MM) | [GetPlatformPartnersIdStatementsPeriod](39_api_response_shapes.md#getplatformpartnersidstatementsperiod) |
| GET | `/api/platform/v1/partner/commissions/statements/:period/pdf` | `platform.partner.commissions.view` | Your monthly statement as a PDF | File |
| GET | `/api/platform/v1/partner/commissions/statements/:period/csv` | `platform.partner.export` | Your monthly statement as CSV | File |

### P-RES-05 · Confirm payouts

**As a** reseller, **I want to** see my payouts and confirm receipt **so that** both sides agree.

*Surface: Partner console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/partner/payouts` | `platform.partner.commissions.view` | Payouts made to you | [GetPlatformPartnersIdPayoutsItem](39_api_response_shapes.md#getplatformpartnersidpayoutsitem)[] |
| POST | `/api/platform/v1/partner/payouts/:id/acknowledge` | `platform.partner.commissions.view` | Confirm you received a payout | [PayoutView2](39_api_response_shapes.md#payoutview2) |

### P-RES-06 · Manage colleagues

**As a** reseller, **I want to** invite, disable and enable colleagues **so that** my team has access.

*Surface: Partner console*

**Acceptance criteria**

- Needs `platform.partner.users.manage`, which is not a default capability.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/partner/users` | `platform.partner.users.manage` | Your colleagues' console accounts | [GetPlatformPartnerUsersItem](39_api_response_shapes.md#getplatformpartnerusersitem)[] |
| POST | `/api/platform/v1/partner/users/invitations` | `platform.partner.users.manage` | Invite a colleague | [PostPlatformPartnersIdUsersInvitations](39_api_response_shapes.md#postplatformpartnersidusersinvitations) |
| POST | `/api/platform/v1/partner/users/:id/disable` | `platform.partner.users.manage` | Disable a colleague's account | No body (204) |
| POST | `/api/platform/v1/partner/users/:id/enable` | `platform.partner.users.manage` | Enable a colleague's account | No body (204) |

---

# Part 6: Keeping the platform healthy

## Health, alerts and launch

### P-HLT-01 · See system health

**As an** on-call engineer, Operations staff member or Support agent, **I want to** see database, jobs, email, backups and migrations **so that** I can spot trouble.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/health` | `platform.health.view` | System health summary: database, jobs, email, backups, migrations | [GetPlatformHealth](39_api_response_shapes.md#getplatformhealth) |

### P-HLT-02 · Handle alerts

**As an** on-call engineer, Operations staff member or Support agent, **I want to** see alerts, acknowledge and resolve them, and see where they go **so that** nothing critical is missed.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/alerts` | `platform.health.view` | Alerts, most severe and most recent first | [GetPlatformAlertsItem](39_api_response_shapes.md#getplatformalertsitem)[] |
| GET | `/api/platform/v1/alerts/:id` | `platform.health.view` | One alert | [GetPlatformAlertsItem](39_api_response_shapes.md#getplatformalertsitem) |
| POST | `/api/platform/v1/alerts/:id/acknowledge` | `platform.alerts.manage` | Acknowledge an alert (someone is on it) | [GetPlatformAlertsItem](39_api_response_shapes.md#getplatformalertsitem) |
| POST | `/api/platform/v1/alerts/:id/resolve` | `platform.alerts.manage` | Resolve an alert | [GetPlatformAlertsItem](39_api_response_shapes.md#getplatformalertsitem) |
| GET | `/api/platform/v1/alerts/on-call` | `platform.alerts.manage` | Where alerts go: on-call emails, the webhook, the minimum severity | [GetPlatformAlertsOnCall](39_api_response_shapes.md#getplatformalertsoncall) |

### P-HLT-03 · Check launch readiness

**As an** on-call engineer or Operations staff member, **I want to** run the go-live gate **so that** I know what is left before launch.

*Surface: Console*

**Acceptance criteria**

- `ready` is true when nothing fails; warnings are judgement calls.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/launch/readiness` | `platform.health.view` | The go-live gate: every launch condition the platform can check (docs/36) | [GetPlatformLaunchReadiness](39_api_response_shapes.md#getplatformlaunchreadiness) |

### P-HLT-04 · Open status incidents

**As a** Support agent or on-call engineer, **I want to** open an incident and post updates **so that** customers see honest status.

*Surface: Console*

**Acceptance criteria**

- A resolved update closes it.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/incidents` | `platform.health.view` | Incidents (open, and the last 90 days) | [GetPlatformIncidentsItem](39_api_response_shapes.md#getplatformincidentsitem)[] |
| POST | `/api/platform/v1/incidents` | `platform.support.incidents.manage` | Open an incident on the status page | [GetPlatformIncidentsItem](39_api_response_shapes.md#getplatformincidentsitem) |
| POST | `/api/platform/v1/incidents/:id/updates` | `platform.support.incidents.manage` | Post an update (status, message; resolved closes it) | [GetPlatformIncidentsItem](39_api_response_shapes.md#getplatformincidentsitem) |

### P-HLT-05 · Schedule maintenance

**As an** Operations staff member or on-call engineer, **I want to** schedule and cancel a window **so that** tenants get a countdown.

*Surface: Console*

**Acceptance criteria**

- May make every tenant read-only during the window.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/maintenance-windows` | `platform.support.maintenance.manage` (step-up) | Schedule maintenance (countdown banner; optionally read-only for every tenant) | [PostPlatformMaintenanceWindows](39_api_response_shapes.md#postplatformmaintenancewindows) |
| GET | `/api/platform/v1/maintenance-windows` | `platform.health.view` | Maintenance windows | [PostPlatformMaintenanceWindows](39_api_response_shapes.md#postplatformmaintenancewindows)[] |
| POST | `/api/platform/v1/maintenance-windows/:id/cancel` | `platform.support.maintenance.manage` (step-up) | Cancel a maintenance window | [PostPlatformMaintenanceWindows](39_api_response_shapes.md#postplatformmaintenancewindows) |

### P-HLT-06 · Publish announcements

**As a** Support agent, **I want to** draft, publish and withdraw banners and emails **so that** tenants hear important news.

*Surface: Console*

**Acceptance criteria**

- Emailing many tenants waits for a Super Admin.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/announcements` | `platform.support.announcements.manage` | Draft an announcement (banner, and optionally email to owners) | [PostPlatformAnnouncements](39_api_response_shapes.md#postplatformannouncements) |
| GET | `/api/platform/v1/announcements` | `platform.support.announcements.manage` | Announcements (newest first) | [PostPlatformAnnouncements](39_api_response_shapes.md#postplatformannouncements)[] |
| GET | `/api/platform/v1/announcements/:id` | `platform.support.announcements.manage` | An announcement with its reach and reads | [GetPlatformAnnouncementsId](39_api_response_shapes.md#getplatformannouncementsid) |
| POST | `/api/platform/v1/announcements/:id/publish` | `platform.support.announcements.manage` | Publish (emailing many tenants waits for a Super Admin's approval) | [PostPlatformAnnouncementsIdPublish](39_api_response_shapes.md#postplatformannouncementsidpublish) |
| POST | `/api/platform/v1/announcements/:id/withdraw` | `platform.support.announcements.manage` | Withdraw an announcement | [PostPlatformAnnouncements](39_api_response_shapes.md#postplatformannouncements) |

## Flags and modules

### P-FLG-01 · Manage flags

**As an** on-call engineer, **I want to** add and change flags and kill switches, and debug them **so that** features can be turned on or stopped safely.

*Surface: Console*

**Acceptance criteria**

- Turning off a kill switch stops the feature for everyone: confirm clearly.
- The debugger explains what a flag resolves to for a tenant, and why.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/flags` | `platform.health.view` | Feature flags and kill switches | [GetPlatformFlagsItem](39_api_response_shapes.md#getplatformflagsitem)[] |
| POST | `/api/platform/v1/flags` | `platform.flags.manage` (step-up) | Add a feature flag or kill switch | [PostPlatformFlags](39_api_response_shapes.md#postplatformflags) |
| GET | `/api/platform/v1/flags/:key` | `platform.health.view` | A flag with its per-tenant overrides | [GetPlatformFlagsKey](39_api_response_shapes.md#getplatformflagskey) |
| PATCH | `/api/platform/v1/flags/:key` | `platform.flags.manage` (step-up) | Change a flag (turning a kill switch off stops the feature for everyone) | [PostPlatformFlags](39_api_response_shapes.md#postplatformflags) |
| GET | `/api/platform/v1/flags/:key/resolve` | `platform.health.view` | Flag debugger: what a flag resolves to for a tenant, and why | [GetPlatformFlagsKeyResolve](39_api_response_shapes.md#getplatformflagskeyresolve) |

### P-FLG-02 · Toggle a module for a tenant

**As an** on-call engineer, **I want to** turn a feature on or off for one tenant, or clear it **so that** tenants get what they pay for.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| PUT | `/api/platform/v1/tenants/:id/flags/:key` | `platform.flags.manage` (step-up) | Turn a feature on or off for one tenant (module toggle) | [PutPlatformTenantsIdFlagsKey](39_api_response_shapes.md#putplatformtenantsidflagskey) |
| POST | `/api/platform/v1/tenants/:id/flags/:key/clear` | `platform.flags.manage` (step-up) | Remove a tenant's override (the flag decides again) | No body (204) |

### P-FLG-03 · Keep vehicle reference data

**As an** Operations staff member, **I want to** add makes and models **so that** every tenant's picker is complete.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/reference/vehicle-makes` | `platform.reference.manage` | Add a vehicle make | [GetReferenceVehicleMakesItem](39_api_response_shapes.md#getreferencevehiclemakesitem) |
| POST | `/api/platform/v1/reference/vehicle-makes/:id/models` | `platform.reference.manage` | Add a model to a make | [GetReferenceVehicleMakesIdModelsItem](39_api_response_shapes.md#getreferencevehiclemakesidmodelsitem) |

### P-FLG-04 · Check a connect link

**As a** Support agent or on-call engineer, **I want to** verify a link as the app would **so that** I can diagnose mobile connect problems.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/mobile/connect-links/verify` | `platform.mobile.view` | Check a connect link as the app would (signature, server, business, expiry) | object / object |

## Backups, migrations and clusters

### P-DAT-01 · See backups

**As an** Operations staff member or on-call engineer, **I want to** see the catalogue, summary and a tenant's backups **so that** I know we can recover.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/backups` | `platform.data.backups.view` | Backup catalogue (newest first) | [GetPlatformTenantsIdBackupsItem](39_api_response_shapes.md#getplatformtenantsidbackupsitem)[] |
| GET | `/api/platform/v1/backups/summary` | `platform.data.backups.view` | Backup status: last platform backup, last restore test, tenants without a recent backup | [GetPlatformBackupsSummary](39_api_response_shapes.md#getplatformbackupssummary) |
| GET | `/api/platform/v1/tenants/:id/backups` | `platform.data.backups.view` | Backups of a tenant (newest first) | [GetPlatformTenantsIdBackupsItem](39_api_response_shapes.md#getplatformtenantsidbackupsitem)[] |

### P-DAT-02 · See migrations

**As an** Operations staff member or on-call engineer, **I want to** see versions, tenants by version and failures **so that** schemas stay in step.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/migrations` | `platform.data.migrations.view` | Schema migrations: platform version, tenants by version, failures | [GetPlatformMigrations](39_api_response_shapes.md#getplatformmigrations) |

### P-DAT-03 · Run restore drills

**As an** Operations staff member or on-call engineer, **I want to** see, record and reschedule drills **so that** recovery is rehearsed.

*Surface: Console*

**Acceptance criteria**

- Recording schedules the next quarter's.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/restore-drills` | `platform.data.backups.view` | Restore drills: the next one scheduled and past results | [GetPlatformRestoreDrillsItem](39_api_response_shapes.md#getplatformrestoredrillsitem)[] |
| POST | `/api/platform/v1/restore-drills/:id/record` | `platform.data.drills.manage` | Record a drill's result (schedules the next quarter's) | [PostPlatformRestoreDrillsIdRecord](39_api_response_shapes.md#postplatformrestoredrillsidrecord) |
| POST | `/api/platform/v1/restore-drills/:id/reschedule` | `platform.data.drills.manage` | Move a scheduled drill | [GetPlatformRestoreDrillsItem](39_api_response_shapes.md#getplatformrestoredrillsitem) |

### P-DAT-04 · Manage clusters

**As an** Operations staff member or on-call engineer, **I want to** add, rename, drain, reopen and retire clusters **so that** tenants have room.

*Surface: Console*

**Acceptance criteria**

- A live probe runs before adding. The main cluster is never drained or retired.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/clusters` | `platform.data.clusters.view` | Clusters with their tenants, capacity, a live probe and the open sweep findings | [GetPlatformClusters](39_api_response_shapes.md#getplatformclusters) |
| POST | `/api/platform/v1/clusters` | `platform.data.clusters.manage` (step-up) | Adds a cluster whose server is ready (roles, template, rights); probed first | [ClusterView](39_api_response_shapes.md#clusterview) |
| GET | `/api/platform/v1/clusters/:id` | `platform.data.clusters.view` | A cluster with its tenants, capacity and a live probe | [ClusterView](39_api_response_shapes.md#clusterview) |
| PATCH | `/api/platform/v1/clusters/:id` | `platform.data.clusters.manage` (step-up) | Renames a cluster, changes its capacity or notes, or drains, reopens or retires it | [ClusterView](39_api_response_shapes.md#clusterview) |

### P-DAT-05 · Move a tenant

**As an** Operations staff member, **I want to** ask to move a tenant to another cluster and follow it **so that** load stays balanced.

*Surface: Console*

**Acceptance criteria**

- Needs four-eyes approval. The tenant is offline during the copy (`503 TENANT_MOVING`).

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/tenants/:id/cluster-move` | `platform.tenants.move_cluster` (step-up) | Asks to move a tenant's database to another cluster; offline while it is copied (four-eyes) | [PostPlatformTenantsIdColdArchive](39_api_response_shapes.md#postplatformtenantsidcoldarchive) |
| GET | `/api/platform/v1/clusters/moves` | `platform.data.clusters.view` | Moves of tenants between clusters, newest first | [GetPlatformClustersMovesItem](39_api_response_shapes.md#getplatformclustersmovesitem)[] |
| GET | `/api/platform/v1/clusters/moves/:id` | `platform.data.clusters.view` | A move with its steps, the copy's check report and the time offline | [GetPlatformClustersMovesItem](39_api_response_shapes.md#getplatformclustersmovesitem) |

### P-DAT-06 · Clean up orphan databases

**As an** Operations staff member or on-call engineer, **I want to** sweep clusters and ask to drop an orphan **so that** no data is left behind.

*Surface: Console*

**Acceptance criteria**

- A Super Admin approves the drop, which is possible only after the wait.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/clusters/findings` | `platform.data.clusters.view` | What the orphan sweep found on each cluster, and whether it may be dropped yet | [FindingView](39_api_response_shapes.md#findingview)[] |
| POST | `/api/platform/v1/clusters/sweep` | `platform.data.clusters.manage` (step-up) | Sweeps every cluster for orphan, moved-away, stray and missing databases now | [PostPlatformClustersSweep](39_api_response_shapes.md#postplatformclusterssweep) |
| POST | `/api/platform/v1/clusters/:id/databases/:name/drop` | `platform.data.clusters.manage` (step-up) | Asks to drop an orphan database once it has waited long enough (Super Admin approves) | [PostPlatformTenantsIdColdArchive](39_api_response_shapes.md#postplatformtenantsidcoldarchive) |

## Cold archive, erasure and data rights

### P-ARC-01 · Archive a long-gone tenant

**As an** Operations staff member, **I want to** ask to move a tenant to cold archive, or bring one back **so that** we keep costs down without losing data.

*Surface: Console*

**Acceptance criteria**

- Applies to a tenant deactivated for a year. Another staff member approves.
- The restore itself is carried out by an operator after approval.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/tenants/:id/cold-archive` | `platform.tenants.archive_cold` (step-up) | Asks to move a tenant deactivated for a year to cold archive (another staff member approves) | [PostPlatformTenantsIdColdArchive](39_api_response_shapes.md#postplatformtenantsidcoldarchive) |
| POST | `/api/platform/v1/tenants/:id/cold-archive/restore` | `platform.tenants.restore_cold_archive` (step-up) | Asks to bring a tenant back from cold archive (approved, then restored by an operator) | [PostPlatformTenantsIdColdArchive](39_api_response_shapes.md#postplatformtenantsidcoldarchive) |
| GET | `/api/platform/v1/archives` | `platform.data.backups.view` | Cold archives with their checks, yearly restore tests and restores | [GetPlatformArchivesItem](39_api_response_shapes.md#getplatformarchivesitem)[] |
| GET | `/api/platform/v1/archives/:id` | `platform.data.backups.view` | A cold archive: the dump, its checks, the files manifest and its restore tests | [GetPlatformArchivesItem](39_api_response_shapes.md#getplatformarchivesitem) |

### P-ARC-02 · Erase a person

**As a** Super Admin, **I want to** preview and ask to erase someone's personal data **so that** legal requests are honoured.

*Surface: Console*

**Acceptance criteria**

- Show the preview first. A Super Admin approves.
- Ledger, invoices, payments and issued documents stay as legal records. The owner can never be erased.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/tenants/:id/erasures/preview` | `platform.security.dsr.anonymise` (step-up) | The person to erase as they are now, with the related records that go too | [GetPlatformTenantsIdErasuresPreview](39_api_response_shapes.md#getplatformtenantsiderasurespreview) |
| POST | `/api/platform/v1/tenants/:id/erasures` | `platform.security.dsr.anonymise` (step-up) | Asks to erase a person's personal data in a tenant (a Super Admin approves) | [PostPlatformTenantsIdColdArchive](39_api_response_shapes.md#postplatformtenantsidcoldarchive) |
| GET | `/api/platform/v1/erasures` | `platform.security.dsr.manage` | The erasure ledger: who was erased where, when, and how often it was reapplied | [GetPlatformErasuresItem](39_api_response_shapes.md#getplatformerasuresitem)[] |

### P-ARC-03 · Track data-protection requests

**As a** Support agent, **I want to** log, step through and close access, correction, erasure and objection requests **so that** deadlines are met.

*Surface: Console*

**Acceptance criteria**

- Open requests come first, by deadline.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/data-protection-requests` | `platform.security.dsr.manage` | Data-protection requests (open first, by deadline) | [GetPlatformDataProtectionRequestsItem](39_api_response_shapes.md#getplatformdataprotectionrequestsitem)[] |
| POST | `/api/platform/v1/data-protection-requests` | `platform.security.dsr.manage` | Log a data-protection request (access, correction, erasure, objection) | [GetPlatformDataProtectionRequestsItem](39_api_response_shapes.md#getplatformdataprotectionrequestsitem) |
| GET | `/api/platform/v1/data-protection-requests/:id` | `platform.security.dsr.manage` | A data-protection request with its steps | [GetPlatformDataProtectionRequestsItem](39_api_response_shapes.md#getplatformdataprotectionrequestsitem) |
| POST | `/api/platform/v1/data-protection-requests/:id/steps` | `platform.security.dsr.manage` | Record a step (and optionally reassign) | [GetPlatformDataProtectionRequestsItem](39_api_response_shapes.md#getplatformdataprotectionrequestsitem) |
| POST | `/api/platform/v1/data-protection-requests/:id/close` | `platform.security.dsr.manage` | Close a request: completed or rejected, with the outcome | [GetPlatformDataProtectionRequestsItem](39_api_response_shapes.md#getplatformdataprotectionrequestsitem) |

### P-ARC-04 · Export a tenant's data

**As an** Operations staff member, **I want to** start an export for an owner **so that** they can leave with their data.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/tenants/:id/data-exports` | `platform.data.exports.manage` (step-up) | A tenant's data exports | [PostDataExports](39_api_response_shapes.md#postdataexports)[] |
| POST | `/api/platform/v1/tenants/:id/data-exports` | `platform.data.exports.manage` (step-up) | Export a tenant's data for its owner (the exit path) | [PostDataExports](39_api_response_shapes.md#postdataexports) |

### P-ARC-05 · Publish legal documents

**As a** Super Admin, **I want to** draft, edit and publish terms, privacy and DPA, and see who accepted **so that** we are covered.

*Surface: Console*

**Acceptance criteria**

- Publish now or from a date ahead.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/legal-documents` | `platform.legal.view` | Terms, privacy and DPA versions | [GetPlatformLegalDocumentsItem](39_api_response_shapes.md#getplatformlegaldocumentsitem)[] |
| POST | `/api/platform/v1/legal-documents` | `platform.legal.manage` (step-up) | Draft a new version | [GetPlatformLegalDocumentsItem](39_api_response_shapes.md#getplatformlegaldocumentsitem) |
| GET | `/api/platform/v1/legal-documents/:id` | `platform.legal.view` | A version, with which tenants accepted it | [GetPlatformLegalDocumentsId](39_api_response_shapes.md#getplatformlegaldocumentsid) |
| PATCH | `/api/platform/v1/legal-documents/:id` | `platform.legal.manage` (step-up) | Edit a draft | [GetPlatformLegalDocumentsItem](39_api_response_shapes.md#getplatformlegaldocumentsitem) |
| POST | `/api/platform/v1/legal-documents/:id/publish` | `platform.legal.manage` (step-up) | Publish a version (in force now, or from a date ahead) | [GetPlatformLegalDocumentsItem](39_api_response_shapes.md#getplatformlegaldocumentsitem) |

## Enterprise services

### P-ENT-01 · Add a custom domain

**As an** Operations staff member, **I want to** add, check and remove a tenant's domain **so that** they can use their own address.

*Surface: Console*

**Acceptance criteria**

- Show the DNS records needed. It goes live once they are right.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/tenants/:id/domains` | `platform.tenants.view` | A tenant's custom domains with the DNS records each needs | [GetPlatformTenantsIdDomainsItem](39_api_response_shapes.md#getplatformtenantsiddomainsitem)[] |
| POST | `/api/platform/v1/tenants/:id/domains` | `platform.tenants.domains.manage` | Adds a custom domain, pending until its DNS proves it (Enterprise) | [GetPlatformTenantsIdDomainsItem](39_api_response_shapes.md#getplatformtenantsiddomainsitem) |
| POST | `/api/platform/v1/tenants/:id/domains/:domainId/verify` | `platform.tenants.domains.manage` | Checks a domain's DNS now; it goes live when the records are right | [GetPlatformTenantsIdDomainsItem](39_api_response_shapes.md#getplatformtenantsiddomainsitem) |
| DELETE | `/api/platform/v1/tenants/:id/domains/:domainId` | `platform.tenants.domains.manage` | Removes a custom domain | No body (204) |

### P-ENT-02 · Step in on integrations

**As an** Operations staff member, **I want to** see a tenant's keys and webhooks, revoke a leaked key or switch off an address **so that** a leak is stopped quickly.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/tenants/:id/integrations` | `platform.tenants.view` | A tenant's API keys and webhooks with their use | [GetPlatformTenantsIdIntegrations](39_api_response_shapes.md#getplatformtenantsidintegrations) |
| POST | `/api/platform/v1/tenants/:id/api-keys/:keyId/revoke` | `platform.tenants.integrations.manage` (step-up) | Revokes a tenant's API key, e.g. when it has leaked | No body (204) |
| POST | `/api/platform/v1/tenants/:id/webhooks/:endpointId/disable` | `platform.tenants.integrations.manage` (step-up) | Switches off a tenant's webhook address | No body (204) |

### P-ENT-03 · Dedicate a cluster

**As an** Operations staff member or on-call engineer, **I want to** keep a cluster for one Enterprise tenant **so that** they are isolated.

*Surface: Console*

**Acceptance criteria**

- `tenantId: null` opens it to all again.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/platform/v1/clusters/:id/dedication` | `platform.data.clusters.manage` (step-up) | Keeps a cluster for one Enterprise tenant, or opens it to all again (tenantId null) | [ClusterView](39_api_response_shapes.md#clusterview) |

### P-ENT-04 · Give a tenant its own database login

**As an** Operations staff member, **I want to** see, give, rotate or take back the login **so that** a tenant's data has its own credential.

*Surface: Console*

**Acceptance criteria**

- Four-eyes. The password is never shown.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/tenants/:id/database-login` | `platform.tenants.view` | Whether a tenant has its own database login, never its password | object / object |
| POST | `/api/platform/v1/tenants/:id/database-login` | `platform.tenants.database_credentials.manage` (step-up) | Asks to give a tenant its own database login, rotate it or take it back (four-eyes) | [PostPlatformTenantsIdColdArchive](39_api_response_shapes.md#postplatformtenantsidcoldarchive) |

---

# Part 7: Growth analytics

## Analytics

### P-ANL-01 · See the growth funnel

**As a** Sales / Onboarding staff member or Billing / Finance staff member, **I want to** see applications through to paying **so that** I know where we lose people.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/analytics/funnel` | `platform.analytics.view` | Applications in a period through verified, approved, provisioned, first vehicle, first payment and paying | [GetPlatformAnalyticsFunnel](39_api_response_shapes.md#getplatformanalyticsfunnel) |

### P-ANL-02 · See adoption and health

**As a** Sales / Onboarding staff member or Billing / Finance staff member, **I want to** see module use and health scores **so that** I can help tenants before they leave.

*Surface: Console*

**Acceptance criteria**

- Score 0 to 100; at-risk below 40; expansion-ready from 75.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/analytics/adoption` | `platform.analytics.view` | Live tenants using each module over 30 days, and those expected to that do not | [GetPlatformAnalyticsAdoption](39_api_response_shapes.md#getplatformanalyticsadoption) |
| GET | `/api/platform/v1/analytics/health` | `platform.analytics.view` | Health scores of live tenants, weakest first; at_risk, expansion_ready or new | [TenantHealthView](39_api_response_shapes.md#tenanthealthview)[] |
| GET | `/api/platform/v1/analytics/tenants/:id` | `platform.analytics.view` | A tenant's health score, its parts and its onboarding checklist | [TenantHealthView](39_api_response_shapes.md#tenanthealthview) |

### P-ANL-03 · See cohorts and churn

**As a** Sales / Onboarding staff member or Billing / Finance staff member, **I want to** see retention by month and deactivation reasons **so that** I understand the trend.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/analytics/cohorts` | `platform.analytics.view` | Tenants by month provisioned: retention by activity, paying and MRR | [GetPlatformAnalyticsCohortsItem](39_api_response_shapes.md#getplatformanalyticscohortsitem)[] |
| GET | `/api/platform/v1/analytics/churn` | `platform.analytics.view` | Tenants deactivated in a period by reason, and those restored | [GetPlatformAnalyticsChurn](39_api_response_shapes.md#getplatformanalyticschurn) |

### P-ANL-04 · See cost to serve

**As a** Billing / Finance staff member, **I want to** see each tenant's cost against MRR, and set rates **so that** pricing is sound.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/analytics/cost-to-serve` | `platform.analytics.view` | Each live tenant's monthly cost from its size, calls and jobs against its MRR | [GetPlatformAnalyticsCostToServe](39_api_response_shapes.md#getplatformanalyticscosttoserve) |
| GET | `/api/platform/v1/analytics/cost-rates` | `platform.analytics.view` | What serving a tenant costs a month | [GetPlatformAnalyticsCostRates](39_api_response_shapes.md#getplatformanalyticscostrates) |
| PUT | `/api/platform/v1/analytics/cost-rates` | `platform.settings.manage` (step-up) | Set what serving a tenant costs a month (minor units) | [GetPlatformAnalyticsCostRates](39_api_response_shapes.md#getplatformanalyticscostrates) |

### P-ANL-05 · See reseller performance

**As a** Sales / Onboarding staff member or Billing / Finance staff member, **I want to** see tenants, MRR, health and commission per partner **so that** I back the right resellers.

*Surface: Console*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/platform/v1/analytics/resellers` | `platform.analytics.view` | Reseller performance: tenants, live, paying, churned, MRR, health and commission | [GetPlatformAnalyticsResellers](39_api_response_shapes.md#getplatformanalyticsresellers) |

---

# Appendix A: Staff roles

| Role | Purpose |
|---|---|
| Super Admin | Everything, including staff management and approving dangerous actions |
| Operations | Applications, tenant lifecycle, branches, data operations |
| Support | Find tenants and users, reset access, read-only support access |
| Billing / Finance | Plans, invoices, payments, refunds, extensions |
| Sales / Onboarding | Signup queue, trials, tenant health, partners — no destructive actions |
| Engineering / On-call | Health, jobs, flags and diagnostics; no tenant business data |
| Auditor (read-only) | Audit log, access reviews and reports |

# Appendix B: Permissions by staff role

Abbreviations: Ops(erations), Sup(port), Bil(ling / Finance), Sal(es / Onboarding), Eng(ineering / On-call), Aud(itor). Super Admin holds everything. **Step** means the permission needs a recent step-up. Reseller capabilities are in Appendix C.

| Permission | What it allows | Step | Held by |
|---|---|---|---|
| `platform.dashboard.view` | View the console dashboard |  | Ops, Sup, Bil, Sal, Eng, Aud |
| `platform.health.view` | View system health |  | Ops, Sup, Eng |
| `platform.alerts.manage` | Acknowledge and configure alerts |  | Ops, Sup, Eng |
| `platform.applications.view` | View tenant applications |  | Ops, Sup, Sal |
| `platform.applications.review` | Review applications and request information |  | Ops |
| `platform.applications.approve` | Approve applications (provisions a tenant) |  | Ops |
| `platform.applications.reject` | Reject applications |  | Ops |
| `platform.applications.create_assisted` | Create assisted applications |  | Ops, Sal |
| `platform.tenants.view` | View tenants and their operational data |  | Ops, Sup, Bil, Sal |
| `platform.tenants.edit` | Edit tenant profile data |  | Ops |
| `platform.tenants.notes` | Add internal notes and tags |  | Ops, Sup, Sal |
| `platform.tenants.activate` | Activate tenants |  | Ops |
| `platform.tenants.deactivate` | Deactivate tenants (special cases) | Step | Ops |
| `platform.tenants.restore` | Restore deactivated tenants | Step | Ops |
| `platform.tenants.set_read_only` | Put tenants in read-only mode | Step | Ops |
| `platform.tenants.set_licence_type` | Set the licence type (before first payment) |  | Ops |
| `platform.tenants.archive_cold` | Move a long-deactivated tenant to cold archive | Step | Ops |
| `platform.tenants.restore_cold_archive` | Restore a tenant from cold archive | Step | Ops |
| `platform.tenants.transfer_ownership` | Transfer tenant ownership | Step | Ops |
| `platform.tenants.move_cluster` | Move a tenant to another database cluster | Step | Ops |
| `platform.tenants.rename_slug` | Change a tenant's slug | Step | Ops |
| `platform.tenants.domains.manage` | Add, check and remove a tenant's custom domains |  | Ops |
| `platform.tenants.integrations.manage` | Revoke a tenant's API keys and switch off its webhooks | Step | Ops |
| `platform.tenants.database_credentials.manage` | Ask to give a tenant its own database login, rotate it or take it back | Step | Ops |
| `platform.tenants.demos.manage` | Create demo and sandbox tenants with sample data, extend and end them |  | Ops, Sal |
| `platform.branches.view` | View tenant branches |  | Ops, Sup |
| `platform.branches.manage` | Create, deactivate and reactivate branches |  | Ops |
| `platform.billing.view` | View billing |  | Ops, Bil |
| `platform.billing.manage` | Manage plans, subscriptions and invoices |  | Bil |
| `platform.billing.payments.record` | Record payments |  | Bil |
| `platform.billing.prices.manage` | Change plan prices | Step | Bil |
| `platform.billing.refunds.issue` | Issue refunds and credits | Step | Bil |
| `platform.billing.extensions.grant` | Grant payment extensions |  | Ops, Bil |
| `platform.users.search` | Search tenant users |  | Ops, Sup |
| `platform.users.reset_access` | Reset a tenant user's password, unlock, sign out, disable or enable them | Step | Sup |
| `platform.users.recover_owner` | Give a tenant owner who lost access a new sign-in email (identity checked) | Step | Ops |
| `platform.support.access_tenant` | Read-only support access to a tenant |  | Ops, Sup |
| `platform.support.access_tenant_write` | Write-mode support access to a tenant | Step | Ops |
| `platform.support.announcements.manage` | Manage announcements |  | Sup |
| `platform.support.maintenance.manage` | Schedule maintenance windows (optionally read-only for every tenant) | Step | Ops, Eng |
| `platform.support.sessions.view` | View support-access sessions and their request trail |  | Ops, Sup, Aud |
| `platform.support.incidents.manage` | Open incidents and post updates on the public status page |  | Sup, Eng |
| `platform.support.tickets.view` | View support tickets and their messages |  | Ops, Sup, Sal, Eng, Aud |
| `platform.support.tickets.manage` | Log, answer, escalate and resolve support tickets |  | Sup, Eng |
| `platform.support.canned_responses.manage` | Write and retire canned responses |  | Sup |
| `platform.support.settings.manage` | Set the support SLA targets and the onboarding task templates |  | Ops |
| `platform.support.onboarding.manage` | Work the onboarding concierge's tasks for new tenants |  | Ops, Sup, Sal |
| `platform.flags.manage` | Manage feature flags and kill switches | Step | Eng |
| `platform.entitlements.override` | Override a tenant's limits (active branches beyond what is billed) | Step | Ops |
| `platform.catalogue.view` | View the permission catalogue and role templates |  |  |
| `platform.catalogue.publish` | Publish permission catalogue and role template changes | Step |  |
| `platform.data.backups.view` | View backups and restore tests |  | Ops, Eng |
| `platform.data.backups.restore` | Restore tenant data from a backup | Step | Ops |
| `platform.data.migrations.view` | View tenant schema versions and failures |  | Ops, Eng |
| `platform.data.exports.manage` | See tenants' data exports and start one for an owner (exit path) | Step | Ops |
| `platform.data.drills.manage` | Schedule restore drills and record their results |  | Ops, Eng |
| `platform.data.migrations.run` | Run schema migrations | Step | Ops, Eng |
| `platform.data.jobs.manage` | Retry and cancel background jobs |  | Ops, Eng |
| `platform.data.clusters.view` | View database clusters, their capacity, tenant moves and orphan databases |  | Ops, Eng |
| `platform.data.clusters.manage` | Add and change database clusters; ask to drop an orphan database | Step | Ops, Eng |
| `platform.data.scripts.run` | Run curated one-off data scripts | Step | Ops |
| `platform.security.audit.view` | View and export the platform audit log |  | Aud |
| `platform.security.dsr.anonymise` | Anonymise personal data for an erasure request | Step |  |
| `platform.security.access_review.view` | View the staff access review |  | Aud |
| `platform.security.dsr.manage` | Track data-protection requests (access, correction, erasure, objection) |  | Sup |
| `platform.legal.view` | View terms and privacy versions and who accepted them |  | Sup, Aud |
| `platform.legal.manage` | Draft and publish terms, privacy policy and DPA versions | Step |  |
| `platform.analytics.view` | View platform analytics |  | Bil, Sal, Aud |
| `platform.reference.manage` | Maintain platform reference data (vehicle makes and models) |  | Ops |
| `platform.mobile.view` | Diagnose mobile connect links and app settings |  | Sup, Eng |
| `platform.settings.manage` | Manage platform settings | Step |  |
| `platform.staff.view` | View staff accounts and roles |  | Aud |
| `platform.staff.manage` | Invite, disable and enable staff, assign roles, reset staff MFA | Step |  |
| `platform.roles.manage` | Create and edit custom staff roles | Step |  |
| `platform.partners.view` | View reseller partners and their tenants |  | Ops, Bil, Sal |
| `platform.partners.manage` | Create and edit partner profiles, pause/resume, invite partner users |  | Sal |
| `platform.partners.permissions.grant` | Grant or revoke a partner's capabilities | Step |  |
| `platform.partners.terminate` | Terminate a partner | Step |  |
| `platform.partners.attribution.manage` | Assign or change the partner a tenant is attributed to | Step |  |
| `platform.partners.commission_terms.manage` | Set a reseller's commission terms and per-tenant overrides | Step |  |
| `platform.partners.commissions.pay` | Record, approve (cash, as second approver) and reverse reseller payouts |  | Bil |
| `platform.partners.adjust` | Add commission adjustments (credits and debits) for a reseller | Step |  |
| `platform.partners.reports.view` | Commission liability and reseller reports |  | Bil |
| `platform.approvals.approve` | Approve or reject four-eyes requests of other staff | Step | Ops |

# Appendix C: Reseller capabilities

Granted per partner. **Default** marks what a new partner receives.

| Capability | What it allows | Default |
|---|---|---|
| `platform.partner.tenants.view` | See the tenants they brought on board | Default |
| `platform.partner.tenants.view_owner_contact` | See the owner's name, phone and email of their tenants |  |
| `platform.partner.tenants.view_billing_state` | See subscription state and deactivation reasons of their tenants |  |
| `platform.partner.tenants.view_onboarding` | See onboarding progress of their tenants |  |
| `platform.partner.commissions.view` | See their commission ledger, statements and payouts | Default |
| `platform.partner.terms.view` | See their own commission terms | Default |
| `platform.partner.applications.create` | Submit assisted signups for clients | Default |
| `platform.partner.applications.respond` | Answer information requests on their applications | Default |
| `platform.partner.export` | Export their tenants and commissions |  |
| `platform.partner.coupons.use` | Offer coupons up to the configured maximum discount |  |
| `platform.partner.referral_tools.view` | See their referral code and link | Default |
| `platform.partner.users.manage` | Invite, disable and enable their colleagues' console accounts |  |
