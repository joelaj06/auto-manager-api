# 37 — User stories: business side

Written for the teams building the **web portal, the mobile app and the driver app**. These stories cover everything a business and its people can do. The platform side (our staff console and the reseller portal) is in [38_user_stories_platform.md](38_user_stories_platform.md).

**Status:** all of this is built in the API as of 2026-11-04 (Phases 0–9). Hosting is not ready, so nothing here has been used on a live server yet. Run the API locally to build against it.

**Size:** 247 stories covering 721 endpoints.

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

- Base path is `/api/v1`. Send `Authorization: Bearer <access token>` on signed-in routes.
- Send the business slug as `X-Tenant`. Some address is required on routes marked `Public (X-Tenant)`. A browser on `<slug>.<domain>` or a custom domain needs no header: the request's `Origin` or `Host` identifies the business instead; if the two disagree the API answers `401 TENANT_MISMATCH`.
- Tokens: access 15 minutes, refresh 30 days, rotated on each use (these are defaults and can be configured).

**Reading and sending data**

- Success is `{ "data": ... }`, sometimes with `meta`. Errors are `{ "error": { "code", "message", "details"?, "remainingAttempts"?, "requestId"? } }`.
- Branch on `error.code`, not on the message. Show `requestId` on failure screens so support can trace it.
- Send money as text, for example `"250.00"`, never as a number. Responses return money as `{ amountMinor, currency, formatted }`, or as fields ending in `Minor`: see [39_api_response_shapes.md](39_api_response_shapes.md).
- Lists take `page` (from 1) and `pageSize`, and answer with the headers `X-Total-Count`, `X-Page` and `X-Page-Size`, so you can show page numbers and jump to any page. The largest and default page size differ by route: see each route's query parameters. A page past the end is an empty list with the true total. The fuel report takes `limit`: it is a report over the latest logs rather than a list of pages. Notifications still give `meta.unread`.
- Long jobs answer `202` and are followed by polling, for example report files.

**Status codes to design for**

| Status | Code | What the screen should do |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Show `details` beside each field |
| 401 | `INVALID_TOKEN` | Refresh once, then retry |
| 401 | `INVALID_REFRESH_TOKEN`, `REFRESH_TOKEN_REUSED` | Go to sign-in |
| 403 | `FORBIDDEN` | The user lacks the permission: hide the action, or explain |
| 403 | `FEATURE_DISABLED` | The module is off for this business |
| 403 | `TENANT_DEACTIVATED` | Show the deactivated screen; billing users go to the billing tab |
| 403 | `ENTERPRISE_LICENCE_REQUIRED` | Offer the upgrade path |
| 403 | `SUPPORT_READ_ONLY`, `SUPPORT_ACTION_BLOCKED` | Autoforce support is viewing in a limited session |
| 403 | `TENANT_READ_ONLY` | Reads work; disable writes |
| 422 | Various | A business rule refused the action: show `message` |
| 429 | `RATE_LIMITED` | Wait and retry. General limit 300 a minute, credentials 30 a minute (defaults) |
| 503 | `MAINTENANCE_READ_ONLY` | Reads work; show the maintenance notice |
| 503 | `TENANT_MOVING` | Back within minutes; honour `Retry-After` |

**Known gaps to plan around**

- **Use [api/openapi.json](api/openapi.json) to generate clients, not the running API's `GET /api/v1/openapi.json`.** The file includes response bodies; the served document still has requests only.
- Response shapes come from the TypeScript types and were compared with responses recorded in the integration tests. Those tests reach 696 of the 999 routes, so the remaining 303 rest on the types alone.
- Some responses carry extra fields that are not documented: `now` when creating a purchase, an appraisal, a test drive or a remittance declaration, and `today` on an appraisal. They are internal leftovers, so do not use them.
- Some actions are refined inside the operation, not at the route, so a user can pass the listed permission and still be refused or see fewer fields: `finance.cash_sessions.view`, `finance.fx_rates.override`, `vehicles.financials.view`, `dealer.deals.discount`, `rentals.discount.apply`, `rentals.price.override`, `support.tickets.view_all`.
- A few writes sit behind a view permission: rental photos (`rentals.view`), deal photos and the loan answer (`dealer.deals.view`). Gate on what is listed.
- Changing a vehicle block needs only sign-in at the route, with the check made inside the operation.

## Not built

Do not design for these yet: a customer self-service portal, drivers paying from the app (tenant payments are recorded, not collected), remote immobilisation, driver scoring, a map of our own, and polling tracking providers.

## Contents

**Part 1: Joining and running the account**

- [Applying for an account](#applying-for-an-account)
- [Signing in and my session](#signing-in-and-my-session)
- [Users and roles](#users-and-roles)
- [Business profile, branches and settings](#business-profile-branches-and-settings)
- [Uploading files](#uploading-files)
- [Notifications](#notifications)
- [Connecting the mobile app](#connecting-the-mobile-app)
- [Help, legal and my data](#help-legal-and-my-data)

**Part 2: Vehicles and people**

- [Vehicle register](#vehicle-register)
- [Assigning vehicles to drivers](#assigning-vehicles-to-drivers)
- [Drivers](#drivers)
- [Customers](#customers)
- [Suppliers](#suppliers)
- [Remittances and daily operations](#remittances-and-daily-operations)
- [The driver app](#the-driver-app)
- [Vehicle issues](#vehicle-issues)
- [Documents and signatures](#documents-and-signatures)

**Part 3: Work & Pay**

- [Work & Pay agreements](#work--pay-agreements)

**Part 4: Rentals**

- [Rental set-up](#rental-set-up)
- [Availability and booking](#availability-and-booking)
- [Check-out and check-in](#check-out-and-check-in)
- [Rental money](#rental-money)

**Part 5: Keeping vehicles on the road**

- [Service plans](#service-plans)
- [Work orders](#work-orders)
- [Parts](#parts)
- [Incidents, claims, offences and fuel](#incidents-claims-offences-and-fuel)
- [Telematics and GPS](#telematics-and-gps)

**Part 6: Money**

- [Expenses](#expenses)
- [Invoices, payments and cash](#invoices-payments-and-cash)
- [Accounting export and reconciliation](#accounting-export-and-reconciliation)

**Part 7: Buying and selling vehicles**

- [Vehicle purchases](#vehicle-purchases)
- [Dealer stock](#dealer-stock)
- [Leads, test drives and quotes](#leads-test-drives-and-quotes)
- [Trade-ins, deals and commissions](#trade-ins-deals-and-commissions)

**Part 8: Seeing the whole business**

- [Dashboards](#dashboards)
- [Reports](#reports)

**Part 9: Integrations and our subscription**

- [API keys and webhooks](#api-keys-and-webhooks)
- [Our Autoforce subscription](#our-autoforce-subscription)
- [Technical endpoints](#technical-endpoints)

---

# Part 1: Joining and running the account

## Applying for an account

A business applies, proves its email and phone, and waits for review. Nothing here needs a token: the applicant holds the application id and an `X-Application-Token`.

### B-ONB-01 · Pick a business address

**As an** applicant, **I want to** check that the short name for my business address is free as I type **so that** I do not finish the form only to be refused.

*Surface: Web, Mobile*

**Acceptance criteria**

- Show free or taken next to the field while typing.
- The slug chosen here is the value later sent as `X-Tenant`.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/applications/slug-availability` | Public | Is this business address name free? | [GetApplicationsSlugAvailability](39_api_response_shapes.md#getapplicationsslugavailability) |

### B-ONB-02 · Apply for an account

**As an** applicant, **I want to** submit my business details **so that** Autoforce can review them and open my account.

*Surface: Web, Mobile*

**Acceptance criteria**

- Submitting sends both an email code and a phone code.
- Keep the application id and token on the device; every later step needs them.
- Link the terms and privacy policy in force from the public legal pages.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/applications` | Public | Apply for an account (sends email and phone verification codes) | [PostApplications](39_api_response_shapes.md#postapplications) |
| GET | `/api/v1/public/legal/:kind` | Public | The terms of service, privacy policy or DPA in force | [GetPublicLegalKind](39_api_response_shapes.md#getpubliclegalkind) |

### B-ONB-03 · Verify my email and phone

**As an** applicant, **I want to** enter the codes sent to me, and ask for new ones **so that** my application goes forward for review.

*Surface: Web, Mobile*

**Acceptance criteria**

- Each contact is verified separately; show which one is still waiting.
- Handle wrong, expired and locked codes differently (`OTP_INVALID`, `OTP_EXPIRED`, `OTP_LOCKED`, with `remainingAttempts`).

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/applications/:id/verify` | Public | Verify the email or phone code | object / object (no envelope) |
| POST | `/api/v1/applications/:id/resend-code` | Public | Send a new email or phone code | No body (204) |

### B-ONB-04 · Follow my application and answer questions

**As an** applicant, **I want to** see where my application stands and reply when staff ask for more **so that** I can fix problems without phoning anyone.

*Surface: Web, Mobile*

**Acceptance criteria**

- Show the status and the messages exchanged.
- A reply may correct details as well as answer the question.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/applications/:id` | Public | Application status and messages (applicant) | object / object (no envelope) |
| POST | `/api/v1/applications/:id/reply` | Public | Answer an information request (and correct details) | object / object (no envelope) |

### B-ONB-05 · Attach KYC documents

**As an** applicant, **I want to** upload, review and remove my business documents while the application is open **so that** staff can check who I am.

*Surface: Web, Mobile*

**Acceptance criteria**

- Upload is three steps: request, PUT to the pre-signed URL, confirm.
- Removal is only possible while the application is open.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/applications/:id/documents` | Public | Attach a KYC document to your application (X-Application-Token) | object / object (no envelope) |
| POST | `/api/v1/applications/:id/documents/:fileId/complete` | Public | Confirm a document upload | object / object (no envelope) |
| GET | `/api/v1/applications/:id/documents` | Public | Documents attached to your application | [PostDealerAppraisalsIdPhotosFileIdComplete](39_api_response_shapes.md#postdealerappraisalsidphotosfileidcomplete)[] |
| DELETE | `/api/v1/applications/:id/documents/:fileId` | Public | Remove a document while the application is open | No body (204) |

## Signing in and my session

Tenant routes send the business slug as `X-Tenant`, except from the business's own address (`<slug>.<domain>` or a custom domain).

### B-AUTH-01 · Find the businesses I belong to

**As a** signed-in user, **I want to** enter my credentials once and see which businesses I can sign in to **so that** I do not have to know a business's address.

*Surface: Mobile*

**Acceptance criteria**

- Use this on a fresh mobile install with no connect link.
- With several businesses, show a picker, then sign in to the chosen one.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/auth/discover` | Public | Businesses you can sign in to with these credentials (mobile app) | [PostAuthDiscoverItem](39_api_response_shapes.md#postauthdiscoveritem)[] |

### B-AUTH-02 · See a business before signing in

**As a** signed-in user, **I want to** see the business's name, status, currency and sign-in methods **so that** I know I am at the right place.

*Surface: Web, Mobile*

**Acceptance criteria**

- Takes `slug`, or the host name on a custom domain.
- A deactivated business says so before the sign-in form is shown.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/public/tenant-config` | Public | What an app needs to connect to a business (name, status, currency, sign-in methods) | [GetPublicTenantConfig](39_api_response_shapes.md#getpublictenantconfig) |

### B-AUTH-03 · Sign in

**As a** signed-in user, **I want to** sign in with my email or phone and password **so that** I can reach my work.

*Surface: Web, Mobile*

**Acceptance criteria**

- Access tokens last 15 minutes by default; refresh tokens 30 days.
- After sign-in, call `GET /me` and build the navigation from its permissions.
- Credential routes share a tight rate limit (30 a minute by default): handle `429`.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/auth/login` | Public (`X-Tenant`) | Sign in with email or phone and password | object / object (no envelope) |
| GET | `/api/v1/me` | Signed-in | Current user, business and permissions | See OpenAPI |

### B-AUTH-04 · Stay signed in

**As a** signed-in user, **I want to** have my session renewed quietly **so that** I am not thrown out in the middle of work.

*Surface: Web, Mobile*

**Acceptance criteria**

- Refresh tokens rotate: store the new one at once.
- `REFRESH_TOKEN_REUSED` and `INVALID_REFRESH_TOKEN` mean sign-in again; never retry them.
- Refresh once for many waiting requests, so two refreshes never race.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/auth/refresh` | Public (`X-Tenant`) | Rotate the refresh token and get a new access token | object / object (no envelope) |

### B-AUTH-05 · Accept my invitation

**As an** invited user, **I want to** set my password from the invitation link **so that** I can start using the business's account.

*Surface: Web, Mobile*

**Acceptance criteria**

- The link opens the app where installed, otherwise the web page.
- `X-Tenant` is required; success signs the user in.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/auth/invitations/accept` | Public (`X-Tenant`) | Set your password from an invitation link and sign in (X-Tenant required) | [PostAuthInvitationsAccept](39_api_response_shapes.md#postauthinvitationsaccept) |

### B-AUTH-06 · Reset a forgotten password

**As a** signed-in user, **I want to** get a code by email and set a new password **so that** I can get back in on my own.

*Surface: Web, Mobile*

**Acceptance criteria**

- The request always answers 202, so never reveal whether an account exists.
- Success signs the user out everywhere.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/auth/password-reset` | Public (`X-Tenant`) | Email a password reset code (always answers 202) | No body (202) |
| POST | `/api/v1/auth/password-reset/confirm` | Public (`X-Tenant`) | Set a new password with the emailed code (signs out everywhere) | No body (204) |

### B-AUTH-07 · Manage my password and sessions

**As a** signed-in user, **I want to** change my password, see where I am signed in and end a session **so that** I stay in control of my account.

*Surface: Web, Mobile*

**Acceptance criteria**

- Changing the password signs out everywhere, so return to sign-in afterwards.
- On sign-out, also unregister the device from push.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/me/password` | Signed-in | Change your password (signs out everywhere) | No body (204) |
| GET | `/api/v1/me/sessions` | Signed-in | Where you are signed in | [GetMeSessionsItem](39_api_response_shapes.md#getmesessionsitem)[] |
| DELETE | `/api/v1/me/sessions/:id` | Signed-in | Sign out one of your sessions | No body (204) |
| POST | `/api/v1/auth/logout` | Signed-in | End the current session | No body (204) |

### B-AUTH-08 · Know what I may do

**As a** signed-in user, **I want to** have the app show only what my permissions and branches allow **so that** I never tap into a refusal.

*Surface: Web, Mobile*

**Acceptance criteria**

- `GET /me/permissions` gives each permission's scope (`own`, `branch` or `all`) and its branches.
- Combine these with `GET /features`: a module needs both the permission and the feature.
- The server still decides; handle `403 FORBIDDEN` everywhere.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/me/permissions` | Signed-in | Your permissions with their scope and branches | [GetMePermissions](39_api_response_shapes.md#getmepermissions) |
| GET | `/api/v1/features` | Signed-in | Which features are on for your business | [GetFeatures](39_api_response_shapes.md#getfeatures) |

## Users and roles

### B-USR-01 · See the people in my business

**As an** Owner, Branch Manager or Administrator, **I want to** list, search and open users **so that** I know who has access.

*Surface: Web*

**Acceptance criteria**

- Filter by status and search; results stay within the viewer's branches unless they have all-branch access.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/users` | `users.list` | Users (within your branches unless you have all-branch access) | [GetUsersItem](39_api_response_shapes.md#getusersitem)[] |
| GET | `/api/v1/users/:id` | `users.view` | A user with their branches and roles | [GetUsersItem](39_api_response_shapes.md#getusersitem) |

### B-USR-02 · Invite a user

**As an** Owner, Administrator or Branch Manager, **I want to** invite someone and give them roles **so that** they can start work.

*Surface: Web*

**Acceptance criteria**

- The invitation is an emailed link; offer to resend it.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/users/invitations` | `users.invite` | Invite a user (emailed link to set a password) | [PostUsersInvitations](39_api_response_shapes.md#postusersinvitations) |
| POST | `/api/v1/users/:id/invitation/resend` | `users.invite` | Send a new invitation link | No body (204) |

### B-USR-03 · Keep users up to date

**As an** Owner, Administrator or Branch Manager, **I want to** edit a user's name, phone and branches, and their roles per branch **so that** access matches their job.

*Surface: Web*

**Acceptance criteria**

- Role assignment is per branch or for all their branches.
- Nobody can grant more than they hold (`ROLE_EXCEEDS_OWN_PERMISSIONS`).

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| PATCH | `/api/v1/users/:id` | `users.update` | Update a user's name, phone or branches | No body (204) |
| PUT | `/api/v1/users/:id/roles` | `roles.assign` | Replace a user's role assignments (per branch or for all their branches) | No body (204) |

### B-USR-04 · Take access away

**As an** Owner, Administrator or Branch Manager, **I want to** disable a user, re-enable them, or sign them out everywhere **so that** someone who left cannot get in.

*Surface: Web*

**Acceptance criteria**

- Disabling also signs the user out everywhere.
- At least one owner must always remain.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/users/:id/disable` | `users.disable` | Disable a user (signs them out everywhere) | No body (204) |
| POST | `/api/v1/users/:id/enable` | `users.disable` | Re-enable a user | No body (204) |
| POST | `/api/v1/users/:id/sessions/revoke` | `sessions.revoke` | Sign a user out everywhere | [PostUsersIdSessionsRevoke](39_api_response_shapes.md#postusersidsessionsrevoke) |

### B-USR-05 · Shape custom roles

**As an** Owner or Administrator, **I want to** create, clone, edit and delete roles from the permissions my business can grant **so that** access fits how we work.

*Surface: Web*

**Acceptance criteria**

- System roles are read-only; clone one to change it. Sensitive permissions are not copied into clones by default.
- Editing a role re-evaluates its holders at once. Only a role nobody holds can be deleted.
- Show each permission's description, scopes and sensitive flag.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/roles` | `roles.list` | Roles with their permissions and number of holders | [GetRolesItem](39_api_response_shapes.md#getrolesitem)[] |
| GET | `/api/v1/roles/:id` | `roles.view` | A role | [GetRolesItem](39_api_response_shapes.md#getrolesitem) |
| POST | `/api/v1/roles` | `roles.create` | Create a custom role (optionally cloned from another role) | [PostUsersInvitations](39_api_response_shapes.md#postusersinvitations) |
| PUT | `/api/v1/roles/:id` | `roles.update` | Edit a custom role (holders are re-evaluated at once) | No body (204) |
| DELETE | `/api/v1/roles/:id` | `roles.delete` | Delete a custom role nobody holds | No body (204) |
| GET | `/api/v1/permissions` | `permissions.list` | The permissions your business can grant | [GetPermissionsItem](39_api_response_shapes.md#getpermissionsitem)[] |

## Business profile, branches and settings

### B-ORG-01 · Keep the business profile

**As an** Owner or Administrator, **I want to** edit the profile and upload a logo **so that** documents and the app carry the right identity.

*Surface: Web*

**Acceptance criteria**

- The logo is uploaded through the file flow, then set; `null` removes it.
- The base currency is not edited here; see the currency settings.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/organisation` | `organisation.view` | Business profile and settings | [PutOrganisationLogo](39_api_response_shapes.md#putorganisationlogo) |
| PATCH | `/api/v1/organisation` | `organisation.update` | Update the business profile (base currency: /settings/currency) | [PutOrganisationLogo](39_api_response_shapes.md#putorganisationlogo) |
| PUT | `/api/v1/organisation/logo` | `organisation.update` | Set the business logo to an uploaded logo file (null removes it) | [PutOrganisationLogo](39_api_response_shapes.md#putorganisationlogo) |

### B-ORG-02 · Add a branch

**As an** Owner or Administrator, **I want to** see what one more branch costs, then confirm and create it **so that** I never add to my bill by accident.

*Surface: Web*

**Acceptance criteria**

- Always show the price impact before the confirm step.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/branches` | `branches.list` | Branches of your business | [GetPlatformTenantsIdBranchesItem](39_api_response_shapes.md#getplatformtenantsidbranchesitem)[] |
| GET | `/api/v1/branches/price-impact` | `branches.create` | What one more active branch would cost (shown before you confirm) | [GetPlatformTenantsIdBranchesPriceImpact](39_api_response_shapes.md#getplatformtenantsidbranchespriceimpact) |
| POST | `/api/v1/branches` | `branches.create` | Create a branch | [PostUsersInvitations](39_api_response_shapes.md#postusersinvitations) |

### B-ORG-03 · Manage a branch

**As an** Owner, Administrator or Branch Manager, **I want to** edit a branch and choose the head office **so that** branch details stay correct.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| PATCH | `/api/v1/branches/:id` | `branches.update` | Edit a branch | No body (204) |
| POST | `/api/v1/branches/:id/make-default` | `branches.update` | Make a branch the default (head office) | No body (204) |

### B-ORG-04 · Close a branch safely

**As an** Owner or Administrator, **I want to** see what is still live in a branch, move it elsewhere, then deactivate or reactivate it **so that** nothing is stranded.

*Surface: Web*

**Acceptance criteria**

- Build a wizard: check, reassign, deactivate.
- Removal works only for a branch with no records.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/branches/:id/deactivation-check` | `branches.deactivate` | What is still live in a branch and what blocks deactivating it | [GetPlatformTenantsIdBranchesBranchIdDeactivationCheck](39_api_response_shapes.md#getplatformtenantsidbranchesbranchiddeactivationcheck) |
| POST | `/api/v1/branches/:id/reassign` | `branches.deactivate` | Move everything live in a branch to another branch, before deactivating it | [BranchMove](39_api_response_shapes.md#branchmove) |
| POST | `/api/v1/branches/:id/deactivate` | `branches.deactivate` | Deactivate a branch | No body (204) |
| POST | `/api/v1/branches/:id/reactivate` | `branches.deactivate` | Reactivate a branch | No body (204) |
| POST | `/api/v1/branches/:id/remove` | `branches.deactivate` | Remove (no records only) a branch | No body (204) |

### B-ORG-05 · Set document numbering

**As an** Owner or Administrator, **I want to** choose the format of document numbers **so that** they match my books (for example `INV-2026-000123`).

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/settings/numbering` | `settings.view` | Document numbering formats | [GetSettingsNumbering](39_api_response_shapes.md#getsettingsnumbering) |
| PUT | `/api/v1/settings/numbering` | `settings.numbering.manage` | Set document numbering formats (e.g. invoice: INV-2026-000123) | No body (204) |

### B-ORG-06 · Set currencies

**As an** Owner, Administrator or Accountant, **I want to** choose the base currency, enabled currencies and display options **so that** money shows the way we work.

*Surface: Web*

**Acceptance criteria**

- The base currency can change only before money is recorded.
- A currency stays enabled while open invoices or unpaid expenses use it.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/currencies` | Public | Currency catalogue (code, name, symbol, minor units) | [GetCurrenciesItem](39_api_response_shapes.md#getcurrenciesitem)[] |
| GET | `/api/v1/settings/currency` | `settings.view` | Base currency, enabled currencies and display options | [GetSettingsCurrency](39_api_response_shapes.md#getsettingscurrency) |
| PATCH | `/api/v1/settings/currency` | `settings.currency.manage` | Change currency settings (the base currency only before money is recorded) | [GetSettingsCurrency](39_api_response_shapes.md#getsettingscurrency) |

### B-ORG-07 · Keep exchange rates

**As an** Accountant or Owner, **I want to** enter and remove daily rates **so that** foreign amounts convert properly.

*Surface: Web*

**Acceptance criteria**

- A rate means 1 unit of `quote` = `rate` units of the base currency.
- Forms prefill from the suggestion: the latest rate on or before the date.
- Using another rate on a document needs `finance.fx_rates.override`. Documents keep the rate they were made with.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/fx-rates` | `finance.fx_rates.view` | Exchange rates against the base currency (newest first) | [GetFxRatesItem](39_api_response_shapes.md#getfxratesitem)[] |
| GET | `/api/v1/fx-rates/suggestion` | Signed-in | The rate to suggest on a form: latest on or before the date (or null) | object / null |
| POST | `/api/v1/fx-rates` | `finance.fx_rates.manage` | Enter a rate: 1 unit of `quote` = `rate` units of the base currency | [GetFxRatesItem](39_api_response_shapes.md#getfxratesitem) |
| DELETE | `/api/v1/fx-rates/:id` | `finance.fx_rates.manage` | Remove a rate (documents keep the rate they were made with) | No body (204) |

### B-ORG-08 · Set up tax

**As an** Accountant or Owner, **I want to** keep our tax registration and dated tax codes **so that** documents carry the right levies.

*Surface: Web*

**Acceptance criteria**

- A code is inactive until it has rates; rate periods of one levy never overlap.
- Offer the preview so people can see what a line would carry on a date.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/settings/tax` | `settings.view` | Tax registration settings | [GetSettingsTax](39_api_response_shapes.md#getsettingstax) |
| PUT | `/api/v1/settings/tax` | `settings.tax.manage` | Set tax registration settings | [GetSettingsTax](39_api_response_shapes.md#getsettingstax) |
| GET | `/api/v1/tax-codes` | `settings.view` | The business's tax codes with their rates | [GetTaxCodesItem](39_api_response_shapes.md#gettaxcodesitem)[] |
| GET | `/api/v1/tax-codes/:code` | `settings.view` | One tax code | [GetTaxCodesItem](39_api_response_shapes.md#gettaxcodesitem) |
| POST | `/api/v1/tax-codes` | `settings.tax.manage` | Create a tax code (inactive until it has rates) | [GetTaxCodesItem](39_api_response_shapes.md#gettaxcodesitem) |
| PATCH | `/api/v1/tax-codes/:code` | `settings.tax.manage` | Rename a tax code or change what it applies to | [GetTaxCodesItem](39_api_response_shapes.md#gettaxcodesitem) |
| POST | `/api/v1/tax-codes/:code/rates` | `settings.tax.manage` | Add a rate period (e.g. VAT 15 % from a date); periods of a levy never overlap | [GetTaxCodesItem](39_api_response_shapes.md#gettaxcodesitem) |
| POST | `/api/v1/tax-codes/:code/rates/:rateId/end` | `settings.tax.manage` | End a rate period (it no longer applies from the given date) | [GetTaxCodesItem](39_api_response_shapes.md#gettaxcodesitem) |
| POST | `/api/v1/tax-codes/:code/activate` | `settings.tax.manage` | Make a tax code usable on documents | [GetTaxCodesItem](39_api_response_shapes.md#gettaxcodesitem) |
| POST | `/api/v1/tax-codes/:code/deactivate` | `settings.tax.manage` | Stop using a tax code | [GetTaxCodesItem](39_api_response_shapes.md#gettaxcodesitem) |
| POST | `/api/v1/tax-codes/:code/preview` | `settings.view` | What a document line would carry for an amount on a date | [PostTaxCodesCodePreview](39_api_response_shapes.md#posttaxcodescodepreview) |

## Uploading files

Every photo, scan and receipt in the product uses this pattern, whichever route starts it.

### B-FILE-01 · Upload a file reliably

**As a** signed-in user, **I want to** upload a file straight to storage and have it checked **so that** large files do not fail on slow networks.

*Surface: Web, Mobile, Driver app*

**Acceptance criteria**

- Start the upload, PUT to the pre-signed URL, then confirm. A file is unusable until confirmed.
- Confirmation checks the real size and type, so show its refusal.
- Read links are short-lived: fetch them when needed and do not cache them.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/files/uploads` | Signed-in | Start an upload (returns a pre-signed URL) | object / object (no envelope) |
| POST | `/api/v1/files/:id/complete` | Signed-in | Confirm an upload (checks size and real file type) | object / object (no envelope) |
| GET | `/api/v1/files/:id` | Signed-in | A file with its URL (signed and short-lived for private files) | object / object (no envelope) |

## Notifications

### B-NOT-01 · Read my notifications

**As a** signed-in user, **I want to** see my inbox and an unread count **so that** I notice what needs me.

*Surface: Web, Mobile, Driver app*

**Acceptance criteria**

- The bell badge uses the unread count. The list pages with `page` and `pageSize`.
- Marking read with no `ids` marks everything read.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/notifications` | Signed-in | My notifications, newest first (`meta.unread`) | [GetNotificationsItem](39_api_response_shapes.md#getnotificationsitem)[] |
| GET | `/api/v1/notifications/unread-count` | Signed-in | How many of my notifications are unread (the bell badge) | [GetNotificationsUnreadCount](39_api_response_shapes.md#getnotificationsunreadcount) |
| POST | `/api/v1/notifications/read` | Signed-in | Mark notifications read (all of them without `ids`) | [GetNotificationsUnreadCount](39_api_response_shapes.md#getnotificationsunreadcount) |

### B-NOT-02 · Get push on my phone

**As a** signed-in user, **I want to** register this phone for push **so that** alerts reach me when the app is closed.

*Surface: Mobile, Driver app*

**Acceptance criteria**

- Register the FCM token after sign-in and whenever it changes; unregister on sign-out.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/me/push-devices` | Signed-in | Register this app installation for push (FCM registration token) | No body (204) |
| POST | `/api/v1/me/push-devices/unregister` | Signed-in | Stop push to this app installation (on sign-out) | No body (204) |

### B-NOT-03 · Configure notification rules

**As an** Owner or Administrator, **I want to** set quiet hours, the remittance cut-off and which rules send what **so that** people hear what matters.

*Surface: Web*

**Acceptance criteria**

- SMS waits out quiet hours (21:00 to 07:00 by default); in-app and push do not.
- Provider credentials are never returned.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/settings/notifications` | `settings.view` | Notification settings: SMS provider (without credentials), quiet hours, rules | [GetSettingsNotifications](39_api_response_shapes.md#getsettingsnotifications) |
| PATCH | `/api/v1/settings/notifications` | `settings.notifications.manage` | Change quiet hours, the remittance cut-off time or rules | [GetSettingsNotifications](39_api_response_shapes.md#getsettingsnotifications) |

### B-NOT-04 · Connect our SMS provider

**As an** Owner or Administrator, **I want to** add our Hubtel, Arkesel or mNotify account and send a test **so that** messages come from our own account.

*Surface: Web*

**Acceptance criteria**

- Removing the account stops SMS rules.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| PUT | `/api/v1/settings/notifications/sms` | `settings.notifications.manage` | Set the business's SMS provider account (Hubtel, Arkesel, mNotify) | [GetSettingsNotifications](39_api_response_shapes.md#getsettingsnotifications) |
| DELETE | `/api/v1/settings/notifications/sms` | `settings.notifications.manage` | Remove the SMS provider account (SMS rules stop sending) | [GetSettingsNotifications](39_api_response_shapes.md#getsettingsnotifications) |
| POST | `/api/v1/settings/notifications/sms/test` | `settings.notifications.manage` | Send a test SMS now through the provider account | [PostSettingsNotificationsSmsTest](39_api_response_shapes.md#postsettingsnotificationssmstest) |

### B-NOT-05 · Connect our WhatsApp Business account

**As an** Owner or Administrator, **I want to** add our own Meta Cloud API account and test it **so that** customers can get messages on WhatsApp.

*Surface: Web*

**Acceptance criteria**

- A rule uses WhatsApp once it names an approved template; one-time links stay on SMS.
- SMS is the once-only fallback when a send is refused for good, or the person replied STOP. START lifts STOP.
- Show the webhook address the business must give Meta.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| PUT | `/api/v1/settings/notifications/whatsapp` | `settings.notifications.manage` | Set the business's own WhatsApp Business account (Cloud API) | [GetSettingsNotifications](39_api_response_shapes.md#getsettingsnotifications) |
| DELETE | `/api/v1/settings/notifications/whatsapp` | `settings.notifications.manage` | Remove the WhatsApp account (rules go back to SMS where they also send it) | [GetSettingsNotifications](39_api_response_shapes.md#getsettingsnotifications) |
| POST | `/api/v1/settings/notifications/whatsapp/test` | `settings.notifications.manage` | Send an approved template without parameters now, to check the account | [PostSettingsNotificationsSmsTest](39_api_response_shapes.md#postsettingsnotificationssmstest) |

### B-NOT-06 · Check what was sent

**As an** Owner, Administrator or Auditor (read-only), **I want to** see the delivery log **so that** I can answer "did the driver get that?".

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/notification-deliveries` | `notifications.deliveries.view` | Log of SMS, push and email notifications sent, newest first | [PostSettingsNotificationsSmsTest](39_api_response_shapes.md#postsettingsnotificationssmstest)[] |

### B-NOT-07 · Receive WhatsApp status (system)

**As a** messaging provider (Meta), **I want to** tell Autoforce how messages fared and what people replied **so that** delivery status stays correct.

*Surface: None (server to server)*

**Acceptance criteria**

- No screen is needed. Signed by Meta and checked on the exact bytes.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/webhooks/whatsapp/:tenant` | Public | Meta's handshake when the business sets up its webhook | File |
| POST | `/api/v1/webhooks/whatsapp/:tenant` | Public | How WhatsApp messages fared and what people replied (signed by Meta) | No body (200) |

## Connecting the mobile app

### B-MOB-01 · Connect a phone by QR

**As an** Owner or Administrator, **I want to** show a signed QR code and link **so that** staff can open the app already pointed at our business.

*Surface: Web*

**Acceptance criteria**

- The app checks the signature with its built-in public keys and fetches current keys from the public route.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/mobile/connect-link` | `settings.mobile.connect` | The signed link and QR code that connect the mobile app to your business | [GetMobileConnectLink](39_api_response_shapes.md#getmobileconnectlink) |
| GET | `/api/v1/public/mobile/connect-keys` | Public | Public keys connect links are signed with (embedded in app builds) | [GetPublicMobileConnectKeysItem](39_api_response_shapes.md#getpublicmobileconnectkeysitem)[] |

### B-MOB-02 · Open a connect link

**As a** signed-in user, **I want to** open a link in the app, or be sent to get the app **so that** connecting works whether or not it is installed.

*Surface: Mobile, Web*

**Acceptance criteria**

- Android and iOS verify the app through the `.well-known` files. `/connect` is the landing page.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/.well-known/assetlinks.json` | Public | Android App Links verification | any[] (no envelope) |
| GET | `/.well-known/apple-app-site-association` | Public | iOS Universal Links verification | [GetWellKnownAppleAppSiteAssociation](39_api_response_shapes.md#getwellknownappleappsiteassociation) (no envelope) |
| GET | `/connect` | Public | Landing page of connect links (open the app, or get it) | File |

### B-MOB-03 · Carry a link through an iPhone install

**As a** signed-in user, **I want to** have my connect link waiting after I install the app **so that** I do not have to scan again.

*Surface: Mobile*

**Acceptance criteria**

- `POST /connect` holds the link behind a one-time `XXXXX-XXXXX` code, carried on the clipboard or typed.
- A code works once, for a day at most. Unknown, used and expired codes all give the same 404.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/connect` | Public | Holds a connect link behind a code for after installing on iPhone | File |
| POST | `/api/v1/public/mobile/deferred-links/claim` | Public | The app takes a held connect link with its code (once) | [PostPublicMobileDeferredLinksClaim](39_api_response_shapes.md#postpublicmobiledeferredlinksclaim) |

## Help, legal and my data

### B-HELP-01 · Ask Autoforce for help

**As a** signed-in user, **I want to** raise a ticket, follow it, reply and rate it **so that** I get help from inside the product.

*Surface: Web, Mobile*

**Acceptance criteria**

- Users can set priority up to high. A reply reopens a resolved ticket.
- `support.tickets.view_all` shows every ticket of the business; others see their own.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/support/tickets` | Signed-in | Your support tickets (every ticket of the business with support.tickets.view_all) | [TicketView](39_api_response_shapes.md#ticketview)[] |
| POST | `/api/v1/support/tickets` | Signed-in | Ask Autoforce support for help (we email you when we answer) | [PostSupportTickets](39_api_response_shapes.md#postsupporttickets) |
| GET | `/api/v1/support/tickets/:id` | Signed-in | A support ticket with the conversation | [PostSupportTickets](39_api_response_shapes.md#postsupporttickets) |
| POST | `/api/v1/support/tickets/:id/messages` | Signed-in | Reply on a support ticket (reopens it if it was resolved) | [PostSupportTickets](39_api_response_shapes.md#postsupporttickets) |
| POST | `/api/v1/support/tickets/:id/rating` | Signed-in | Rate how we handled a resolved ticket (1–5) | [TicketView](39_api_response_shapes.md#ticketview) |

### B-HELP-02 · See announcements and maintenance

**As a** signed-in user, **I want to** see platform banners and upcoming maintenance **so that** downtime does not surprise me.

*Surface: Web, Mobile*

**Acceptance criteria**

- During a maintenance window writes return `503 MAINTENANCE_READ_ONLY`; reads still work.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/announcements` | Signed-in | Platform announcements and upcoming maintenance for your business | [GetAnnouncements](39_api_response_shapes.md#getannouncements) |
| POST | `/api/v1/announcements/:id/read` | Signed-in | Mark an announcement read | No body (204) |

### B-HELP-03 · See the service status

**As a** signed-in user, **I want to** check the public status page **so that** I know if a problem is on Autoforce's side.

*Surface: Web, Mobile*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/public/status` | Public | Service status: incidents, components and scheduled maintenance | [GetPublicStatus](39_api_response_shapes.md#getpublicstatus) |

### B-HELP-04 · Accept new terms

**As an** Owner, **I want to** read and accept the terms and privacy policy in force **so that** my business stays compliant.

*Surface: Web*

**Acceptance criteria**

- Everyone can see whether the versions in force are accepted; only `legal.accept` can accept.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/legal` | Signed-in | The terms and privacy policy in force and whether your business accepted them | [GetLegal](39_api_response_shapes.md#getlegal) |
| POST | `/api/v1/legal/accept` | `legal.accept` | Accept the versions in force for your business | [GetLegal](39_api_response_shapes.md#getlegal) |
| GET | `/api/v1/public/legal/:kind` | Public | The terms of service, privacy policy or DPA in force | [GetPublicLegalKind](39_api_response_shapes.md#getpubliclegalkind) |

### B-HELP-05 · Export all our data

**As an** Owner, **I want to** request a full data export and download it **so that** our data is ours to take.

*Surface: Web*

**Acceptance criteria**

- It is built in the background and we are emailed; the download link lasts five minutes.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/data-exports` | `data.export` | Export all your business's data (we email you when it is ready) | [PostDataExports](39_api_response_shapes.md#postdataexports) |
| GET | `/api/v1/data-exports` | `data.export` | Your data exports (newest first) | [PostDataExports](39_api_response_shapes.md#postdataexports)[] |
| POST | `/api/v1/data-exports/:id/download` | `data.export` | A five-minute link to download an export | [PostDataExportsIdDownload](39_api_response_shapes.md#postdataexportsiddownload) |

### B-HELP-06 · See when support opened our business

**As an** Owner or Auditor (read-only), **I want to** see when Autoforce staff accessed us and why, and choose who sees that log **so that** access to our data is accountable.

*Surface: Web*

**Acceptance criteria**

- Hiding the log from users does not stop Autoforce keeping its own trail.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/settings/support-access` | `audit.view` | The support-access log: when Autoforce staff opened your business, and why | [GetSettingsSupportAccess](39_api_response_shapes.md#getsettingssupportaccess) |
| PUT | `/api/v1/settings/support-access` | `settings.update` | Show or hide the support-access log to your users (Autoforce keeps its trail) | No body (204) |

---

# Part 2: Vehicles and people

## Vehicle register

The vehicle is the hub of the product. Status, branch and odometer change through their own endpoints, never through `PATCH /vehicles/:id`.

### B-VEH-01 · Browse the fleet

**As a** Fleet Officer, Branch Manager or Owner, **I want to** list, filter and search vehicles **so that** I find any car fast.

*Surface: Web, Mobile*

**Acceptance criteria**

- Filters: status, branch, usage, group, make, tag and search. Off-fleet vehicles are hidden unless `includeOffFleet`.
- Make and model pickers come from the reference lists.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/vehicles` | `vehicles.list` | Vehicles in your branches (in the fleet unless includeOffFleet) | [GetVehiclesItem](39_api_response_shapes.md#getvehiclesitem)[] |
| GET | `/api/v1/vehicle-statuses` | Signed-in | Vehicle statuses with their transitions (which ones users may set by hand) | [GetVehicleStatusesItem](39_api_response_shapes.md#getvehiclestatusesitem)[] |
| GET | `/api/v1/reference/vehicle-makes` | Signed-in | Vehicle makes (search with q) | [GetReferenceVehicleMakesItem](39_api_response_shapes.md#getreferencevehiclemakesitem)[] |
| GET | `/api/v1/reference/vehicle-makes/:id/models` | Signed-in | Models of a make | [GetReferenceVehicleMakesIdModelsItem](39_api_response_shapes.md#getreferencevehiclemakesidmodelsitem)[] |

### B-VEH-02 · Register and edit a vehicle

**As a** Fleet Officer or Branch Manager, **I want to** add a vehicle and correct its details **so that** it exists for every module.

*Surface: Web, Mobile*

**Acceptance criteria**

- Show custom fields from the vehicle settings.
- Delete is for mistaken entries: it asks for a reason and hides the vehicle everywhere.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/vehicles` | `vehicles.create` | Register a vehicle | [GetVehiclesItem](39_api_response_shapes.md#getvehiclesitem) |
| PATCH | `/api/v1/vehicles/:id` | `vehicles.update` | Edit a vehicle (status, branch and odometer have their own endpoints) | [GetVehiclesItem](39_api_response_shapes.md#getvehiclesitem) |
| DELETE | `/api/v1/vehicles/:id` | `vehicles.delete` | Remove a mistaken entry (kept with the reason, hidden everywhere) | No body (204) |

### B-VEH-03 · See a vehicle at a glance

**As a** Fleet Officer, Branch Manager or Owner, **I want to** open a 360° view with compliance, distance and timeline **so that** one screen tells the vehicle's story.

*Surface: Web, Mobile*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/vehicles/:id` | `vehicles.view` | A vehicle | [GetVehiclesItem](39_api_response_shapes.md#getvehiclesitem) |
| GET | `/api/v1/vehicles/:id/overview` | `vehicles.view` | Vehicle 360°: header, compliance, distance and the latest timeline | [GetVehiclesIdOverview](39_api_response_shapes.md#getvehiclesidoverview) |
| GET | `/api/v1/vehicles/:id/timeline` | `vehicles.view` | The vehicle's timeline (status changes, documents, odometer), newest first | [GetVehiclesIdTimelineItem](39_api_response_shapes.md#getvehiclesidtimelineitem)[] |

### B-VEH-04 · Change status by hand

**As a** Fleet Officer or Branch Manager, **I want to** move a vehicle to an allowed status with a reason **so that** the register matches reality.

*Surface: Web*

**Acceptance criteria**

- Offer only the options the API returns.
- Moves into or out of a module's state (rented, on Work & Pay) are refused; those modules move the vehicle.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/vehicles/:id/status-options` | `vehicles.change_status` | Statuses you may move this vehicle to by hand | ("accident" / "assigned" / "available" / "for_sale" / "impounded" / "in_maintenance" / "incoming" / "on_rent" / "on_workpay" / "reconditioning" / "repossessed" / "reserved" / "reserved_rental" / "retired" / "scrapped" / "sold" / "stolen" / "transferred" / "written_off")[] |
| POST | `/api/v1/vehicles/:id/status` | `vehicles.change_status` | Change the status by hand (not into or out of a module's state) | [GetVehiclesItem](39_api_response_shapes.md#getvehiclesitem) |
| GET | `/api/v1/vehicles/:id/status-history` | `vehicles.view` | Every status change with its reason and cause | [GetVehiclesIdStatusHistoryItem](39_api_response_shapes.md#getvehiclesidstatushistoryitem)[] |

### B-VEH-05 · Record the odometer

**As a** Fleet Officer or Branch Manager, **I want to** enter a reading and see past ones **so that** service and cost per km stay accurate.

*Surface: Web, Mobile*

**Acceptance criteria**

- A reading can never be lower than before, unless the odometer was replaced.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/vehicles/:id/odometer` | `vehicles.view` | Odometer readings, newest first | [GetVehiclesIdOdometerItem](39_api_response_shapes.md#getvehiclesidodometeritem)[] |
| POST | `/api/v1/vehicles/:id/odometer` | `vehicles.odometer.record` | Record a reading (never lower than before, unless the odometer was replaced) | [GetVehiclesIdOdometerItem](39_api_response_shapes.md#getvehiclesidodometeritem) |

### B-VEH-06 · Keep vehicle papers

**As a** Fleet Officer or Branch Manager, **I want to** add, renew, correct and scan vehicle documents **so that** the car can legally run.

*Surface: Web, Mobile*

**Acceptance criteria**

- A renewal is a new document of the same type.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/vehicles/:id/documents` | `vehicles.documents.view` | Documents with their scans, and the vehicle's compliance | [GetVehiclesIdDocuments](39_api_response_shapes.md#getvehiclesiddocuments) |
| POST | `/api/v1/vehicles/:id/documents` | `vehicles.documents.manage` | Add a document (a renewal is a new document of the same type) | [VehicleDocumentView](39_api_response_shapes.md#vehicledocumentview) |
| PATCH | `/api/v1/vehicles/:id/documents/:documentId` | `vehicles.documents.manage` | Correct a document | [VehicleDocumentView](39_api_response_shapes.md#vehicledocumentview) |
| DELETE | `/api/v1/vehicles/:id/documents/:documentId` | `vehicles.documents.manage` | Remove a document entered by mistake (with its scans) | No body (204) |
| POST | `/api/v1/vehicles/:id/documents/:documentId/files` | `vehicles.documents.manage` | Attach a scan or photo to a document | [PostDealerAppraisalsIdPhotos](39_api_response_shapes.md#postdealerappraisalsidphotos) |
| POST | `/api/v1/vehicles/:id/documents/:documentId/files/:fileId/complete` | `vehicles.documents.manage` | Confirm a document scan upload | [PostDealerAppraisalsIdPhotosFileIdComplete](39_api_response_shapes.md#postdealerappraisalsidphotosfileidcomplete) |
| DELETE | `/api/v1/vehicles/:id/documents/:documentId/files/:fileId` | `vehicles.documents.manage` | Remove a scan from a document | No body (204) |

### B-VEH-07 · See who cannot legally operate

**As a** Fleet Officer or Branch Manager, **I want to** open the compliance board **so that** the worst problems come first.

*Surface: Web*

**Acceptance criteria**

- Vehicles that cannot legally operate today are listed first.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/vehicles/compliance` | `vehicles.documents.view` | Compliance board: vehicles that cannot legally operate today first | [GetVehiclesCompliance](39_api_response_shapes.md#getvehiclescompliance) |

### B-VEH-08 · Manage vehicle photos

**As a** Fleet Officer or Branch Manager, **I want to** upload, remove and choose the primary photo **so that** vehicles are easy to recognise.

*Surface: Web, Mobile*

**Acceptance criteria**

- The first photo becomes primary.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/vehicles/:id/photos` | `vehicles.view` | Photos with short-lived links (one is primary) | [VehiclePhotoView](39_api_response_shapes.md#vehiclephotoview)[] |
| POST | `/api/v1/vehicles/:id/photos` | `vehicles.photos.manage` | Start a photo upload | [PostDealerAppraisalsIdPhotos](39_api_response_shapes.md#postdealerappraisalsidphotos) |
| POST | `/api/v1/vehicles/:id/photos/:fileId/complete` | `vehicles.photos.manage` | Confirm a photo upload (the first photo becomes primary) | [VehiclePhotoView](39_api_response_shapes.md#vehiclephotoview) |
| DELETE | `/api/v1/vehicles/:id/photos/:fileId` | `vehicles.photos.manage` | Remove a photo | No body (204) |
| PUT | `/api/v1/vehicles/:id/primary-photo` | `vehicles.photos.manage` | Choose the primary photo | No body (204) |

### B-VEH-09 · Group vehicles

**As an** Owner or Administrator, **I want to** create groups and add or remove vehicles **so that** I can report on and plan for sets of cars.

*Surface: Web*

**Acceptance criteria**

- Deleting a group keeps its vehicles.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/vehicle-groups` | `vehicles.list` | Vehicle groups with their vehicle counts | [GetVehicleGroupsItem](39_api_response_shapes.md#getvehiclegroupsitem)[] |
| POST | `/api/v1/vehicle-groups` | `vehicles.groups.manage` | Create a vehicle group | [GetVehicleGroupsItem](39_api_response_shapes.md#getvehiclegroupsitem) |
| PATCH | `/api/v1/vehicle-groups/:id` | `vehicles.groups.manage` | Rename a vehicle group | [GetVehicleGroupsItem](39_api_response_shapes.md#getvehiclegroupsitem) |
| DELETE | `/api/v1/vehicle-groups/:id` | `vehicles.groups.manage` | Delete a vehicle group (its vehicles stay) | No body (204) |
| POST | `/api/v1/vehicle-groups/:id/members` | `vehicles.groups.manage` | Add vehicles to and remove vehicles from a group | [GetVehicleGroupsItem](39_api_response_shapes.md#getvehiclegroupsitem) |

### B-VEH-10 · Move vehicles between branches

**As a** Fleet Officer or Branch Manager, **I want to** transfer several vehicles at once **so that** the fleet sits where it works.

*Surface: Web*

**Acceptance criteria**

- All or none: one failure moves nothing.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/vehicles/transfer` | `vehicles.update` | Move vehicles to another branch (all or none) | [GetVehiclesItem](39_api_response_shapes.md#getvehiclesitem)[] |

### B-VEH-11 · Import and export the register

**As a** Fleet Officer or Branch Manager, **I want to** load vehicles from CSV and export the register **so that** moving in and reporting are quick.

*Surface: Web*

**Acceptance criteria**

- Download the template, check, then commit. All rows or none.
- Financial columns export only with `vehicles.financials.view`.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/vehicles/import/template` | `vehicles.import` | CSV template for the vehicle import (with your custom-field columns) | File |
| POST | `/api/v1/vehicles/import` | `vehicles.import` | Check (and with commit: create) vehicles from CSV — all rows or none | [PostVehiclesImport](39_api_response_shapes.md#postvehiclesimport) |
| GET | `/api/v1/vehicles/export` | `vehicles.export` | Export the register as CSV (financial columns only with financials access) | File |

### B-VEH-12 · Set vehicle rules

**As an** Owner or Administrator, **I want to** set required documents, reminders and custom fields **so that** the register fits our business.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/settings/vehicles` | `settings.view` | Vehicle settings: required documents, reminders, custom fields | [GetSettingsVehicles](39_api_response_shapes.md#getsettingsvehicles) |
| PATCH | `/api/v1/settings/vehicles` | `settings.vehicles.manage` | Change vehicle settings | [GetSettingsVehicles](39_api_response_shapes.md#getsettingsvehicles) |

## Assigning vehicles to drivers

### B-ASG-01 · See who has which car

**As a** Fleet Officer or Branch Manager, **I want to** view current assignments and history **so that** I can see the whole board.

*Surface: Web, Mobile*

**Acceptance criteria**

- `open=true` gives the current board.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/assignments` | `vehicles.view` | Assignments in your branches (current board with open=true), newest first | [AssignmentView](39_api_response_shapes.md#assignmentview)[] |
| GET | `/api/v1/vehicles/:id/assignment` | `vehicles.view` | The vehicle's current driver assignment (null when none) | [AssignmentView](39_api_response_shapes.md#assignmentview) / null |

### B-ASG-02 · Find who had a car at a moment

**As a** Fleet Officer or Branch Manager, **I want to** look up the driver at a date and time **so that** fines and accidents reach the right person.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/vehicles/:id/assignment-at` | `vehicles.view` | Who had the vehicle at an instant (traffic fines, accidents) | [AssignmentView](39_api_response_shapes.md#assignmentview) / null |

### B-ASG-03 · Hand a car to a driver

**As a** Fleet Officer or Branch Manager, **I want to** assign an active driver to an available car with a checklist and odometer **so that** the handover is on record.

*Surface: Web, Mobile*

**Acceptance criteria**

- The driver must be active and the vehicle available. Licence rule comes from the settings.
- Choose remittance mode: `fixed_target`, `variable` or `none`.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/vehicles/:id/assignment` | `vehicles.assign_driver` | Assign an active driver to an available vehicle (handover checklist, odometer) | [PostVehiclesIdAssignment](39_api_response_shapes.md#postvehiclesidassignment) |

### B-ASG-04 · Take back or swap a car

**As a** Fleet Officer or Branch Manager, **I want to** end an assignment or hand straight to another driver **so that** the car's custody never has a gap.

*Surface: Web, Mobile*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/vehicles/:id/assignment/end` | `vehicles.assign_driver` | Take the vehicle back (checklist, odometer, reason) | [AssignmentView](39_api_response_shapes.md#assignmentview) |
| POST | `/api/v1/vehicles/:id/assignment/handover` | `vehicles.assign_driver` | Hand the vehicle to another driver in one step | [PostVehiclesIdAssignment](39_api_response_shapes.md#postvehiclesidassignment) |

### B-ASG-05 · Change remittance terms

**As a** Fleet Officer or Branch Manager, **I want to** change the terms of the current assignment **so that** targets stay fair.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| PATCH | `/api/v1/vehicles/:id/assignment/terms` | `vehicles.assign_driver` | Change the remittance terms of the current assignment | [AssignmentView](39_api_response_shapes.md#assignmentview) |

### B-ASG-06 · Set assignment rules

**As an** Owner or Administrator, **I want to** set the handover checklist, default remittance mode and licence rule **so that** handovers are consistent.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/settings/assignments` | `settings.view` | Handover checklist, default remittance mode and licence rule | [GetSettingsAssignments](39_api_response_shapes.md#getsettingsassignments) |
| PATCH | `/api/v1/settings/assignments` | `settings.update` | Change the assignment settings | [GetSettingsAssignments](39_api_response_shapes.md#getsettingsassignments) |

### B-ASG-07 · Print a handover document

**As a** Fleet Officer or Branch Manager, **I want to** issue the handover document or a correction **so that** both sides have the paper.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/assignments/:id/handover-document` | `documents.issue` | Issue the handover document of an assignment (or a correction of it) | [DocumentView](39_api_response_shapes.md#documentview) |

## Drivers

### B-DRV-01 · Find a driver

**As a** Fleet Officer or Branch Manager, **I want to** list, filter and open drivers **so that** I can reach anyone quickly.

*Surface: Web, Mobile*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/drivers` | `drivers.list` | Drivers in your branches | [DriverView](39_api_response_shapes.md#driverview)[] |
| GET | `/api/v1/drivers/:id` | `drivers.view` | A driver with guarantors and the onboarding checklist | [DriverDetailView](39_api_response_shapes.md#driverdetailview) |

### B-DRV-02 · Register a driver

**As a** Fleet Officer or Branch Manager, **I want to** add a driver as an applicant and edit them **so that** onboarding can begin.

*Surface: Web, Mobile*

**Acceptance criteria**

- Remove is only for applicants and terminated drivers.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/drivers` | `drivers.create` | Register a driver (as an applicant) | [DriverDetailView](39_api_response_shapes.md#driverdetailview) |
| PATCH | `/api/v1/drivers/:id` | `drivers.update` | Edit a driver (or move them to another branch) | [DriverDetailView](39_api_response_shapes.md#driverdetailview) |
| DELETE | `/api/v1/drivers/:id` | `drivers.delete` | Remove a mistaken entry (applicants and terminated drivers only) | No body (204) |

### B-DRV-03 · Onboard a driver

**As a** Fleet Officer or Branch Manager, **I want to** see what is still needed and activate the driver **so that** nobody drives before they are ready.

*Surface: Web*

**Acceptance criteria**

- Show the checklist from the onboarding endpoint; requirements come from the settings.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/drivers/:id/onboarding` | `drivers.view` | What is still needed before the driver can start | [GetDriversIdOnboardingItem](39_api_response_shapes.md#getdriversidonboardingitem)[] |
| POST | `/api/v1/drivers/:id/activate` | `drivers.update` | Activate a driver | [DriverDetailView](39_api_response_shapes.md#driverdetailview) |
| GET | `/api/v1/settings/drivers` | `settings.view` | Driver onboarding requirements | [GetSettingsDrivers](39_api_response_shapes.md#getsettingsdrivers) |
| PATCH | `/api/v1/settings/drivers` | `settings.update` | Change the driver onboarding requirements | [GetSettingsDrivers](39_api_response_shapes.md#getsettingsdrivers) |

### B-DRV-04 · Change a driver's standing

**As a** Branch Manager or Fleet Officer, **I want to** suspend, reinstate, terminate or rehire with a reason **so that** their record tells the true story.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/drivers/:id/suspend` | `drivers.suspend` | Suspend a driver | [DriverDetailView](39_api_response_shapes.md#driverdetailview) |
| POST | `/api/v1/drivers/:id/reinstate` | `drivers.suspend` | Reinstate a driver | [DriverDetailView](39_api_response_shapes.md#driverdetailview) |
| POST | `/api/v1/drivers/:id/terminate` | `drivers.terminate` | Terminate a driver | [DriverDetailView](39_api_response_shapes.md#driverdetailview) |
| POST | `/api/v1/drivers/:id/rehire` | `drivers.update` | Rehire a driver | [DriverDetailView](39_api_response_shapes.md#driverdetailview) |
| GET | `/api/v1/drivers/:id/status-history` | `drivers.view` | Status changes with their reasons | [GetDriversIdStatusHistoryItem](39_api_response_shapes.md#getdriversidstatushistoryitem)[] |

### B-DRV-05 · Keep guarantors

**As a** Fleet Officer or Branch Manager, **I want to** add, edit and remove guarantors **so that** someone stands behind the driver.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/drivers/:id/guarantors` | `drivers.update` | Add a guarantor | [PostDriversIdGuarantors](39_api_response_shapes.md#postdriversidguarantors) |
| PATCH | `/api/v1/drivers/:id/guarantors/:guarantorId` | `drivers.update` | Edit a guarantor | [PostDriversIdGuarantors](39_api_response_shapes.md#postdriversidguarantors) |
| DELETE | `/api/v1/drivers/:id/guarantors/:guarantorId` | `drivers.update` | Remove a guarantor | No body (204) |

### B-DRV-06 · Keep identity documents

**As a** Fleet Officer or Branch Manager, **I want to** add, correct and scan IDs for drivers and guarantors **so that** we hold proof of identity.

*Surface: Web, Mobile*

**Acceptance criteria**

- Viewing needs the sensitive `drivers.documents.view`; editing needs only `drivers.update`.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/drivers/:id/documents` | `drivers.documents.view` | Identity documents with their scans (sensitive) | [PartyDocumentView](39_api_response_shapes.md#partydocumentview)[] |
| POST | `/api/v1/drivers/:id/documents` | `drivers.update` | Add an identity document | [PostDriversIdDocuments](39_api_response_shapes.md#postdriversiddocuments) |
| PATCH | `/api/v1/drivers/:id/documents/:documentId` | `drivers.update` | Correct an identity document | [PostDriversIdDocuments](39_api_response_shapes.md#postdriversiddocuments) |
| DELETE | `/api/v1/drivers/:id/documents/:documentId` | `drivers.update` | Remove an identity document with its scans | No body (204) |
| POST | `/api/v1/drivers/:id/documents/:documentId/files` | `drivers.update` | Attach a scan (pre-signed upload, then complete) | [PostDealerAppraisalsIdPhotos](39_api_response_shapes.md#postdealerappraisalsidphotos) |
| POST | `/api/v1/drivers/:id/documents/:documentId/files/:fileId/complete` | `drivers.update` | Confirm a scan upload | [PostDealerAppraisalsIdPhotosFileIdComplete](39_api_response_shapes.md#postdealerappraisalsidphotosfileidcomplete) |
| DELETE | `/api/v1/drivers/:id/documents/:documentId/files/:fileId` | `drivers.update` | Remove a scan | No body (204) |
| GET | `/api/v1/drivers/:id/guarantors/:guarantorId/documents` | `drivers.documents.view` | Identity documents with their scans (sensitive) | [PartyDocumentView](39_api_response_shapes.md#partydocumentview)[] |
| POST | `/api/v1/drivers/:id/guarantors/:guarantorId/documents` | `drivers.update` | Add an identity document | [PostDriversIdDocuments](39_api_response_shapes.md#postdriversiddocuments) |
| PATCH | `/api/v1/drivers/:id/guarantors/:guarantorId/documents/:documentId` | `drivers.update` | Correct an identity document | [PostDriversIdDocuments](39_api_response_shapes.md#postdriversiddocuments) |
| DELETE | `/api/v1/drivers/:id/guarantors/:guarantorId/documents/:documentId` | `drivers.update` | Remove an identity document with its scans | No body (204) |
| POST | `/api/v1/drivers/:id/guarantors/:guarantorId/documents/:documentId/files` | `drivers.update` | Attach a scan (pre-signed upload, then complete) | [PostDealerAppraisalsIdPhotos](39_api_response_shapes.md#postdealerappraisalsidphotos) |
| POST | `/api/v1/drivers/:id/guarantors/:guarantorId/documents/:documentId/files/:fileId/complete` | `drivers.update` | Confirm a scan upload | [PostDealerAppraisalsIdPhotosFileIdComplete](39_api_response_shapes.md#postdealerappraisalsidphotosfileidcomplete) |
| DELETE | `/api/v1/drivers/:id/guarantors/:guarantorId/documents/:documentId/files/:fileId` | `drivers.update` | Remove a scan | No body (204) |

### B-DRV-07 · Watch licences

**As a** Fleet Officer or Branch Manager, **I want to** see licences expired or expiring **so that** nobody drives unlicensed.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/drivers/expiring-licences` | `drivers.list` | Drivers whose licence has expired or expires within `days` | [DriverView](39_api_response_shapes.md#driverview)[] |

### B-DRV-08 · Give a driver app access

**As a** Branch Manager, **I want to** give or remove a driver's app login **so that** they can serve themselves.

*Surface: Web*

**Acceptance criteria**

- A login comes as QR, SMS and email. Removal signs them out everywhere.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/drivers/:id/app-access` | `drivers.app_access.manage` | Whether the driver has a driver-app login | [GetDriversIdAppAccess](39_api_response_shapes.md#getdriversidappaccess) |
| POST | `/api/v1/drivers/:id/app-access` | `drivers.app_access.manage` | Give the driver an app login (or a fresh invitation): QR, SMS and email | [PostDriversIdAppAccess](39_api_response_shapes.md#postdriversidappaccess) |
| DELETE | `/api/v1/drivers/:id/app-access` | `drivers.app_access.manage` | Take the driver's app login away (signs them out everywhere) | [GetDriversIdAppAccess](39_api_response_shapes.md#getdriversidappaccess) |

## Customers

### B-CUS-01 · Register customers

**As a** Rental Agent, Sales Executive or Branch Manager, **I want to** find, add and edit individual or company customers **so that** I can serve them.

*Surface: Web, Mobile*

**Acceptance criteria**

- Search by name, code, phone, email or Ghana Card.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/customers` | `customers.list` | Customers (search by name, code, phone, email or Ghana Card) | [CustomerView](39_api_response_shapes.md#customerview)[] |
| POST | `/api/v1/customers` | `customers.create` | Register a customer (individual or company) | [CustomerView](39_api_response_shapes.md#customerview) |
| GET | `/api/v1/customers/:id` | `customers.view` | A customer | [CustomerView](39_api_response_shapes.md#customerview) |
| PATCH | `/api/v1/customers/:id` | `customers.update` | Edit a customer | [CustomerView](39_api_response_shapes.md#customerview) |
| DELETE | `/api/v1/customers/:id` | `customers.delete` | Remove a mistaken entry | No body (204) |

### B-CUS-02 · Flag risky customers

**As a** Branch Manager or Owner, **I want to** put a customer on watch, blacklist or clear them, with a reason **so that** staff are warned before they serve them.

*Surface: Web*

**Acceptance criteria**

- Bookings check this at booking, confirmation and check-out.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/customers/:id/risk` | `customers.blacklist` | Put a customer on watch, blacklist or clear them (with a reason) | [CustomerView](39_api_response_shapes.md#customerview) |
| GET | `/api/v1/customers/:id/risk-history` | `customers.view` | Risk status changes with their reasons | [GetDriversIdStatusHistoryItem](39_api_response_shapes.md#getdriversidstatushistoryitem)[] |

### B-CUS-03 · Keep customer IDs

**As a** Rental Agent, Sales Executive or Accountant, **I want to** add, correct and scan identity documents **so that** rentals and sales are verified.

*Surface: Web, Mobile*

**Acceptance criteria**

- Viewing scans needs the sensitive `customers.id_documents.view`.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/customers/:id/documents` | `customers.id_documents.view` | Identity documents with their scans (sensitive) | [PartyDocumentView](39_api_response_shapes.md#partydocumentview)[] |
| POST | `/api/v1/customers/:id/documents` | `customers.update` | Add an identity document | [PostDriversIdDocuments](39_api_response_shapes.md#postdriversiddocuments) |
| PATCH | `/api/v1/customers/:id/documents/:documentId` | `customers.update` | Correct an identity document | [PostDriversIdDocuments](39_api_response_shapes.md#postdriversiddocuments) |
| DELETE | `/api/v1/customers/:id/documents/:documentId` | `customers.update` | Remove an identity document with its scans | No body (204) |
| POST | `/api/v1/customers/:id/documents/:documentId/files` | `customers.update` | Attach a scan (pre-signed upload, then complete) | [PostDealerAppraisalsIdPhotos](39_api_response_shapes.md#postdealerappraisalsidphotos) |
| POST | `/api/v1/customers/:id/documents/:documentId/files/:fileId/complete` | `customers.update` | Confirm a scan upload | [PostDealerAppraisalsIdPhotosFileIdComplete](39_api_response_shapes.md#postdealerappraisalsidphotosfileidcomplete) |
| DELETE | `/api/v1/customers/:id/documents/:documentId/files/:fileId` | `customers.update` | Remove a scan | No body (204) |

## Suppliers

### B-SUP-01 · Keep suppliers

**As an** Accountant, Branch Manager or Fleet Officer, **I want to** add, edit, deactivate and remove suppliers **so that** bills and work orders have a payee.

*Surface: Web*

**Acceptance criteria**

- Suppliers include insurers and workshop vendors.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/suppliers` | `suppliers.list` | Suppliers by name | [SupplierView](39_api_response_shapes.md#supplierview)[] |
| POST | `/api/v1/suppliers` | `suppliers.create` | Add a supplier | [SupplierView](39_api_response_shapes.md#supplierview) |
| GET | `/api/v1/suppliers/:id` | `suppliers.view` | A supplier | [SupplierView](39_api_response_shapes.md#supplierview) |
| PATCH | `/api/v1/suppliers/:id` | `suppliers.update` | Edit or deactivate a supplier | [SupplierView](39_api_response_shapes.md#supplierview) |
| DELETE | `/api/v1/suppliers/:id` | `suppliers.delete` | Remove a mistaken entry | No body (204) |

## Remittances and daily operations

### B-REM-01 · Run the day from one board

**As a** Branch Manager or Fleet Officer, **I want to** see fleet out and idle, remittances due, drivers behind and licences **so that** I know where to act first.

*Surface: Web, Mobile*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/operations/board` | `operations.board.view` | Daily operations board: fleet out/idle, remittances due, drivers behind, licences | [GetOperationsBoard](39_api_response_shapes.md#getoperationsboard) |

### B-REM-02 · Review remittances

**As a** Branch Manager or Cashier, **I want to** list and open remittances **so that** I know what each driver owes for each period.

*Surface: Web, Mobile*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/remittances` | `remittances.list` | Remittances in your branches, latest periods first | [RemittanceView](39_api_response_shapes.md#remittanceview)[] |
| GET | `/api/v1/remittances/:id` | `remittances.view` | A remittance with its declarations and payments | [RemittanceView](39_api_response_shapes.md#remittanceview) |

### B-REM-03 · Declare what a driver paid

**As a** Branch Manager or Fleet Officer, **I want to** record a declaration, or declare a variable period **so that** it can be checked before it counts.

*Surface: Web, Mobile*

**Acceptance criteria**

- A declaration waits for approval. Variable mode uses `POST /remittances/declare`.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/remittances/declare` | `remittances.submit` | Declare a variable-mode period (what the driver paid in) | [RemittanceView](39_api_response_shapes.md#remittanceview) |
| POST | `/api/v1/remittances/:id/submissions` | `remittances.submit` | Declare what was paid for the period (waits for approval) | [RemittanceView](39_api_response_shapes.md#remittanceview) |

### B-REM-04 · Confirm or reject declarations

**As a** Branch Manager or Accountant, **I want to** approve money received or reject money not received **so that** the driver's ledger is true.

*Surface: Web, Mobile*

**Acceptance criteria**

- Approving records the payment; rejecting records nothing.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/remittances/:id/submissions/:submissionId/approve` | `remittances.approve` | Confirm a declaration (the money received; records the payment) | [RemittanceView](39_api_response_shapes.md#remittanceview) |
| POST | `/api/v1/remittances/:id/submissions/:submissionId/reject` | `remittances.approve` | Reject a declaration (money not received) | [RemittanceView](39_api_response_shapes.md#remittanceview) |

### B-REM-05 · Take money directly

**As a** Cashier, **I want to** record cash at the desk for a period **so that** the driver is credited at once.

*Surface: Web, Mobile*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/remittances/:id/record` | `remittances.record` | Record money taken for this period directly (cash at the desk …) | [RemittanceView](39_api_response_shapes.md#remittanceview) |

### B-REM-06 · Waive a shortfall

**As an** Accountant or Owner, **I want to** waive all or part of a shortfall with a reason **so that** fair exceptions are on record.

*Surface: Web*

**Acceptance criteria**

- A waiver reduces income. The permission is sensitive.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/remittances/:id/waive` | `remittances.waive` | Waive (part of) the shortfall of a period, with a reason | [RemittanceView](39_api_response_shapes.md#remittanceview) |

### B-REM-07 · See a driver's ledger

**As a** Branch Manager or Accountant, **I want to** view a statement with shortfall ageing and share it **so that** we can settle disagreements.

*Surface: Web*

**Acceptance criteria**

- One running balance; ageing buckets are 0 to 7, 8 to 30 and over 30 days.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/drivers/:id/ledger` | `drivers.ledger.view` | Driver statement: opening, lines, closing balance and shortfall ageing | [GetMeDriverLedger](39_api_response_shapes.md#getmedriverledger) |
| GET | `/api/v1/drivers/:id/ledger/statement.pdf` | `drivers.ledger.view` | A driver's statement for a period, as PDF | File |

### B-REM-08 · Charge or credit a driver

**As an** Accountant or Owner, **I want to** add a deduction or bonus **so that** one-off amounts reach the ledger.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/drivers/:id/ledger/adjustments` | `drivers.ledger.adjust` | Charge a driver (deduction) or credit them (bonus) | [GetMeDriverLedger](39_api_response_shapes.md#getmedriverledger) |

### B-REM-09 · Set remittance rules

**As an** Owner or Administrator, **I want to** set grace days and the shortfall alert **so that** targets match how we operate.

*Surface: Web*

**Acceptance criteria**

- A target is owed after the period plus grace (1 day by default).

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/settings/remittances` | `settings.view` | Remittance settings (grace days, shortfall alert) | [GetSettingsRemittances](39_api_response_shapes.md#getsettingsremittances) |
| PATCH | `/api/v1/settings/remittances` | `settings.update` | Change the remittance settings | [GetSettingsRemittances](39_api_response_shapes.md#getsettingsremittances) |

## The driver app

Everything here needs `driver_app.use`, always scoped to the driver's own records. It is built for low-end Android and poor connections.

### B-DAP-01 · See my home screen

**As a** Driver, **I want to** see me, my vehicle, my terms, my balance and open remittances **so that** I know where I stand when I open the app.

*Surface: Driver app*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/me/driver` | `driver_app.use` | Driver app home: me, my vehicle and terms, my balance and open remittances | [GetMeDriver](39_api_response_shapes.md#getmedriver) |

### B-DAP-02 · See my vehicle and its papers

**As a** Driver, **I want to** see the car I drive and whether its documents are valid **so that** I am not caught out at a checkpoint.

*Surface: Driver app*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/me/driver/vehicle` | `driver_app.use` | The vehicle I drive, with its documents' compliance | [GetMeDriverVehicle](39_api_response_shapes.md#getmedrivervehicle) |

### B-DAP-03 · See my statement

**As a** Driver, **I want to** see my ledger and download it **so that** I can check every charge.

*Surface: Driver app*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/me/driver/ledger` | `driver_app.use` | My statement: opening, lines, closing balance and shortfalls | [GetMeDriverLedger](39_api_response_shapes.md#getmedriverledger) |
| GET | `/api/v1/me/driver/ledger/statement.pdf` | `driver_app.use` | My statement as PDF | File |
| GET | `/api/v1/me/driver/payments/:id/receipt.pdf` | `driver_app.use` | The receipt of one of my payments, as PDF | File |

### B-DAP-04 · Declare my remittance

**As a** Driver, **I want to** see my periods and declare what I paid **so that** my boss can confirm it.

*Surface: Driver app*

**Acceptance criteria**

- A declaration waits for approval, so show it as pending.
- Variable-mode periods are declared with `declare`.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/me/driver/remittances` | `driver_app.use` | My remittance periods, latest first | [RemittanceView](39_api_response_shapes.md#remittanceview)[] |
| POST | `/api/v1/me/driver/remittances/declare` | `driver_app.use` | Declare a period of my vehicle (variable remittance) | [RemittanceView](39_api_response_shapes.md#remittanceview) |
| GET | `/api/v1/me/driver/remittances/:id` | `driver_app.use` | One of my remittance periods with its declarations | [RemittanceView](39_api_response_shapes.md#remittanceview) |
| POST | `/api/v1/me/driver/remittances/:id/submissions` | `driver_app.use` | Declare what I paid for a period (waits for approval) | [RemittanceView](39_api_response_shapes.md#remittanceview) |

### B-DAP-05 · Log fuel

**As a** Driver, **I want to** record a fuel fill I paid for **so that** the business owes me once it is approved.

*Surface: Driver app*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/me/driver/fuel` | `driver_app.use` | Log a fuel fill of my vehicle (paid by me: the business owes me once approved) | [PostMeDriverFuel](39_api_response_shapes.md#postmedriverfuel) |

### B-DAP-06 · Report a problem

**As a** Driver, **I want to** report a breakdown, accident or damage with photos and follow it **so that** help comes quickly.

*Surface: Driver app*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/me/driver/issues` | `driver_app.use` | Report an issue with my vehicle (breakdown, accident, damage …) | [VehicleIssueView](39_api_response_shapes.md#vehicleissueview) |
| GET | `/api/v1/me/driver/issues` | `driver_app.use` | Issues I reported, newest first | [VehicleIssueView](39_api_response_shapes.md#vehicleissueview)[] |
| GET | `/api/v1/me/driver/issues/:id` | `driver_app.use` | One of my issue reports with its photos | [VehicleIssueView](39_api_response_shapes.md#vehicleissueview) |
| POST | `/api/v1/me/driver/issues/:id/photos` | `driver_app.use` | Add a photo to my issue report | [PostDealerAppraisalsIdPhotos](39_api_response_shapes.md#postdealerappraisalsidphotos) |
| POST | `/api/v1/me/driver/issues/:id/photos/:fileId/complete` | `driver_app.use` | Confirm a photo upload of my issue report | [PostDealerAppraisalsIdPhotosFileIdComplete](39_api_response_shapes.md#postdealerappraisalsidphotosfileidcomplete) |

### B-DAP-07 · Follow my Work & Pay

**As a** Driver, **I want to** see my agreements, schedules, statement and transfer letter **so that** I can see my progress to owning the car.

*Surface: Driver app*

**Acceptance criteria**

- Statement PDF is for sharing. The transfer letter link is short-lived and is the signed copy once both have signed.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/me/driver/workpay` | `driver_app.use` | My work and pay agreements with their schedules | [AgreementView](39_api_response_shapes.md#agreementview)[] |
| GET | `/api/v1/me/driver/workpay/:id/transfer-letter` | `driver_app.use` | My transfer letter: a short-lived link to the PDF (signed once both signed) | [GetDocumentsIdDownload](39_api_response_shapes.md#getdocumentsiddownload) |
| GET | `/api/v1/me/driver/workpay/:id/statement` | `driver_app.use` | My agreement statement: paid to date, outstanding, overdue, schedule, payments | [GetMeDriverWorkpayIdStatement](39_api_response_shapes.md#getmedriverworkpayidstatement) |
| GET | `/api/v1/me/driver/workpay/:id/statement.pdf` | `driver_app.use` | My agreement statement as a PDF to share | File |

### B-DAP-08 · Sign what is waiting for me

**As a** Driver, **I want to** sign documents from the app **so that** I do not need to travel to the office.

*Surface: Driver app*

**Acceptance criteria**

- See the signing stories in Documents and signatures.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/me/signatures` | Signed-in | Documents waiting for my signature | [GetMeSignaturesItem](39_api_response_shapes.md#getmesignaturesitem)[] |

## Vehicle issues

### B-ISS-01 · Track issues

**As a** Fleet Officer or Branch Manager, **I want to** log, acknowledge, resolve and reopen issues with photos **so that** nothing a driver reports is forgotten.

*Surface: Web, Mobile*

**Acceptance criteria**

- A work order can be opened from an issue; completing it resolves the issue.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/vehicle-issues` | `vehicles.issues.view` | Issues reported on vehicles in your branches, newest first | [VehicleIssueView](39_api_response_shapes.md#vehicleissueview)[] |
| POST | `/api/v1/vehicles/:id/issues` | `vehicles.issues.manage` | Log an issue with a vehicle | [VehicleIssueView](39_api_response_shapes.md#vehicleissueview) |
| GET | `/api/v1/vehicle-issues/:id` | `vehicles.issues.view` | An issue with its photos | [VehicleIssueView](39_api_response_shapes.md#vehicleissueview) |
| POST | `/api/v1/vehicle-issues/:id/acknowledge` | `vehicles.issues.manage` | Acknowledge an issue (someone is on it) | [VehicleIssueView](39_api_response_shapes.md#vehicleissueview) |
| POST | `/api/v1/vehicle-issues/:id/reopen` | `vehicles.issues.manage` | Reopen a resolved issue | [VehicleIssueView](39_api_response_shapes.md#vehicleissueview) |
| POST | `/api/v1/vehicle-issues/:id/resolve` | `vehicles.issues.manage` | Resolve an issue with what was done | [VehicleIssueView](39_api_response_shapes.md#vehicleissueview) |
| POST | `/api/v1/vehicle-issues/:id/photos` | `vehicles.issues.manage` | Attach a photo to an issue | [PostDealerAppraisalsIdPhotos](39_api_response_shapes.md#postdealerappraisalsidphotos) |
| POST | `/api/v1/vehicle-issues/:id/photos/:fileId/complete` | `vehicles.issues.manage` | Confirm an issue photo upload | [PostDealerAppraisalsIdPhotosFileIdComplete](39_api_response_shapes.md#postdealerappraisalsidphotosfileidcomplete) |

## Documents and signatures

### B-SGN-01 · Find issued documents

**As a** Branch Manager or Rental Agent, **I want to** list, open and download issued documents **so that** papers are one tap away.

*Surface: Web, Mobile*

**Acceptance criteria**

- Downloads are short-lived links with a SHA-256. Choose the copy with `copy`.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/documents` | `documents.list` | Issued documents in your branches, newest first | [DocumentView](39_api_response_shapes.md#documentview)[] |
| GET | `/api/v1/documents/:id` | `documents.view` | A document with its data snapshot and history | [DocumentView](39_api_response_shapes.md#documentview) |
| GET | `/api/v1/documents/:id/download` | `documents.view` | A short-lived link to the document's PDF (or its signed copy), with its SHA-256 | [GetDocumentsIdDownload](39_api_response_shapes.md#getdocumentsiddownload) |

### B-SGN-02 · Void a document

**As an** Owner or Administrator, **I want to** void a document with a reason **so that** mistakes cannot be relied on.

*Surface: Web*

**Acceptance criteria**

- It stays on record and verification shows it as void.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/documents/:id/void` | `documents.void` | Void a document (it stays on record; verification shows it void) | [DocumentView](39_api_response_shapes.md#documentview) |

### B-SGN-03 · Tailor document templates

**As an** Owner or Administrator, **I want to** draft, preview and put in use my own template versions **so that** documents sound like us.

*Surface: Web*

**Acceptance criteria**

- Locked clauses are checked and cannot be removed.
- Going live archives the previous version; going back to the system template is always possible.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/document-types` | `documents.templates.view` | Document types with their fields, system template, locked clauses and version in use | [GetDocumentTypesItem](39_api_response_shapes.md#getdocumenttypesitem)[] |
| POST | `/api/v1/document-types/:type/use-system` | `documents.templates.manage` | Go back to the system template for a type | No body (204) |
| GET | `/api/v1/document-templates` | `documents.templates.view` | The business's template versions, newest first | [GetDocumentTemplatesItem](39_api_response_shapes.md#getdocumenttemplatesitem)[] |
| POST | `/api/v1/document-templates/preview` | `documents.templates.view` | A PDF of a template filled with sample data (the system one without a body) | File |
| POST | `/api/v1/document-templates` | `documents.templates.manage` | Start a new template version (a draft, checked against the locked clauses) | [GetDocumentTemplatesItem](39_api_response_shapes.md#getdocumenttemplatesitem) |
| GET | `/api/v1/document-templates/:id` | `documents.templates.view` | A template version | [GetDocumentTemplatesItem](39_api_response_shapes.md#getdocumenttemplatesitem) |
| PUT | `/api/v1/document-templates/:id` | `documents.templates.manage` | Edit a draft | [GetDocumentTemplatesItem](39_api_response_shapes.md#getdocumenttemplatesitem) |
| DELETE | `/api/v1/document-templates/:id` | `documents.templates.manage` | Delete a draft | No body (204) |
| POST | `/api/v1/document-templates/:id/activate` | `documents.templates.manage` | Put a draft in use for new documents (the previous version is archived) | [GetDocumentTemplatesItem](39_api_response_shapes.md#getdocumenttemplatesitem) |

### B-SGN-04 · Set signing rules

**As an** Owner or Administrator, **I want to** set codes, deadline, reminders, links and typed signatures **so that** signing fits our risk.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/settings/documents` | `settings.view` | Signing settings (codes, deadline, reminders, links, typed signatures) | [GetSettingsDocuments](39_api_response_shapes.md#getsettingsdocuments) |
| PATCH | `/api/v1/settings/documents` | `documents.templates.manage` | Change the signing settings | [GetSettingsDocuments](39_api_response_shapes.md#getsettingsdocuments) |

### B-SGN-05 · Sign as a user

**As a** signed-in user, **I want to** see what awaits me, read it, confirm by code, then sign or decline **so that** my signature is valid and on record.

*Surface: Web, Mobile, Driver app*

**Acceptance criteria**

- The signer reads the PDF first. A signature is drawn (PNG), or typed where allowed, with consent.
- Declining needs a reason.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/me/signatures` | Signed-in | Documents waiting for my signature | [GetMeSignaturesItem](39_api_response_shapes.md#getmesignaturesitem)[] |
| GET | `/api/v1/me/signatures/:signerId` | Signed-in | One signature to give, with the PDF to read first | [GetMeSignaturesItem](39_api_response_shapes.md#getmesignaturesitem) |
| POST | `/api/v1/me/signatures/:signerId/code` | Signed-in | Send me the code that confirms my signature | [PostMeSignaturesSignerIdCode](39_api_response_shapes.md#postmesignaturessigneridcode) |
| POST | `/api/v1/me/signatures/:signerId/sign` | Signed-in | Sign: the code, a drawn (PNG) or typed signature, and consent | [GetMeSignaturesItem](39_api_response_shapes.md#getmesignaturesitem) |
| POST | `/api/v1/me/signatures/:signerId/decline` | Signed-in | Decline to sign, with a reason | [GetMeSignaturesItem](39_api_response_shapes.md#getmesignaturesitem) |

### B-SGN-06 · Sign as a guest

**As a** guest signer, **I want to** open my link, read, confirm by code, then sign or decline **so that** I can sign without an account.

*Surface: Web*

**Acceptance criteria**

- `X-Tenant` is sent; no sign-in is needed. The link stops working once signed.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/public/signing/open` | Public (`X-Tenant`) | The document a signing link is for, with the PDF to read | [GetMeSignaturesItem](39_api_response_shapes.md#getmesignaturesitem) |
| POST | `/api/v1/public/signing/code` | Public (`X-Tenant`) | Send the signer's code | [PostMeSignaturesSignerIdCode](39_api_response_shapes.md#postmesignaturessigneridcode) |
| POST | `/api/v1/public/signing/sign` | Public (`X-Tenant`) | Sign with a signing link (the link then stops working) | [GetMeSignaturesItem](39_api_response_shapes.md#getmesignaturesitem) |
| POST | `/api/v1/public/signing/decline` | Public (`X-Tenant`) | Decline with a signing link | [GetMeSignaturesItem](39_api_response_shapes.md#getmesignaturesitem) |

### B-SGN-07 · Chase signatures

**As a** Branch Manager or Rental Agent, **I want to** send a new link or QR to a guest and remind those who have not signed **so that** documents do not stall.

*Surface: Web*

**Acceptance criteria**

- A new link ends earlier links.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/documents/:id/signers/:signerId/link` | `documents.issue` | A new signing link (and QR) for a guest signer; earlier links stop working | [PostDocumentsIdSignersSignerIdLink](39_api_response_shapes.md#postdocumentsidsignerssigneridlink) |
| POST | `/api/v1/documents/:id/remind` | `documents.issue` | Remind everyone who has not signed yet | [PostDocumentsIdRemind](39_api_response_shapes.md#postdocumentsidremind) |

### B-SGN-08 · Accept a paper signature

**As a** Branch Manager or Rental Agent, **I want to** upload a scan of a paper signature **so that** people without phones can still sign.

*Surface: Web, Mobile*

**Acceptance criteria**

- The signer counts as signed on paper, checked by the uploader.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/documents/:id/signers/:signerId/paper-scans` | `documents.attach_paper` | Upload the scan of a signature made on paper | [PostDealerAppraisalsIdPhotos](39_api_response_shapes.md#postdealerappraisalsidphotos) |
| POST | `/api/v1/documents/:id/signers/:signerId/paper-scans/:fileId/complete` | `documents.attach_paper` | Confirm the scan: the signer counts as signed on paper (checked by you) | [SignerView](39_api_response_shapes.md#signerview) |

### B-SGN-09 · Verify a document

**As a** verifier, **I want to** check a document by its code, and a copy's hash **so that** I know it is genuine.

*Surface: Web*

**Acceptance criteria**

- A public page: anyone with the code can check. Void documents show as void.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/public/documents/:code` | Public (`X-Tenant`) | Check a document by its verification code (and optionally a copy's SHA-256) | object / object |

---

# Part 3: Work & Pay

## Work & Pay agreements

A driver pays off a car over time. Agreements move through draft, signature, running, then completion or an early end. Money is recorded, never collected by the system.

### B-WAP-01 · Try out terms

**As a** Branch Manager, **I want to** simulate price, deposit, instalments and schedule **so that** I can agree terms before saving anything.

*Surface: Web*

**Acceptance criteria**

- Nothing is saved.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/workpay/simulate` | `workpay.view` | Try terms: price, deposit, instalments and the schedule (nothing is saved) | [PostWorkpaySimulate](39_api_response_shapes.md#postworkpaysimulate) |

### B-WAP-02 · Draft an agreement

**As a** Branch Manager, **I want to** draft and change an agreement for a vehicle and driver **so that** terms are ready for signature.

*Surface: Web*

**Acceptance criteria**

- Only a draft can change: terms, guarantors and responsibilities.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/workpay/agreements` | `workpay.view` | Work and pay agreements in your branches, newest first | [AgreementView](39_api_response_shapes.md#agreementview)[] |
| POST | `/api/v1/workpay/agreements` | `workpay.create` | Draft an agreement for a vehicle and a driver | [AgreementView](39_api_response_shapes.md#agreementview) |
| GET | `/api/v1/workpay/agreements/:id` | `workpay.view` | An agreement with its terms, guarantors, document and schedule | [AgreementView](39_api_response_shapes.md#agreementview) |
| PATCH | `/api/v1/workpay/agreements/:id` | `workpay.create` | Change a draft (terms, guarantors, responsibilities) | [AgreementView](39_api_response_shapes.md#agreementview) |

### B-WAP-03 · Send for signature

**As a** Branch Manager, **I want to** issue the agreement to the owner, driver and signing guarantors, or take it back **so that** it becomes binding only once signed.

*Surface: Web*

**Acceptance criteria**

- Withdrawing returns to draft and voids the document.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/workpay/agreements/:id/send-for-signature` | `workpay.create` | Issue the agreement document for the owner, the driver and signing guarantors | [AgreementView](39_api_response_shapes.md#agreementview) |
| POST | `/api/v1/workpay/agreements/:id/withdraw` | `workpay.create` | Take the agreement back to draft (its document is voided) | [AgreementView](39_api_response_shapes.md#agreementview) |

### B-WAP-04 · Take the deposit and start

**As a** Branch Manager or Cashier, **I want to** record the deposit, start the signed agreement, or cancel it before it starts **so that** the schedule begins and the car is handed over.

*Surface: Web*

**Acceptance criteria**

- Starting begins the schedule and hands the vehicle over.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/workpay/agreements/:id/deposit` | `workpay.payment.record` | Record the deposit (or part of it) paid by the driver | [AgreementView](39_api_response_shapes.md#agreementview) |
| POST | `/api/v1/workpay/agreements/:id/activate` | `workpay.activate` | Start the signed agreement: the schedule begins and the vehicle is handed over | [AgreementView](39_api_response_shapes.md#agreementview) |
| POST | `/api/v1/workpay/agreements/:id/cancel` | `workpay.activate` | Cancel an agreement that has not started | [AgreementView](39_api_response_shapes.md#agreementview) |

### B-WAP-05 · Record instalments

**As a** Cashier, Branch Manager or Accountant, **I want to** record a payment and see the balance **so that** the driver's progress is true.

*Surface: Web, Mobile*

**Acceptance criteria**

- A payment pays late fees first, then the oldest instalments.
- Show outstanding, overdue, late fees, days in arrears and the next instalment.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/workpay/agreements/:id/payments` | `workpay.payment.record` | Record an instalment payment: late fees first, then the oldest instalments | [PostWorkpayAgreementsIdPayments](39_api_response_shapes.md#postworkpayagreementsidpayments) |
| GET | `/api/v1/workpay/agreements/:id/payments` | `workpay.view` | Payments on an agreement and what each one paid, newest first | [GetWorkpayAgreementsIdPaymentsItem](39_api_response_shapes.md#getworkpayagreementsidpaymentsitem)[] |
| GET | `/api/v1/workpay/agreements/:id/balance` | `workpay.view` | Outstanding, overdue, late fees, days in arrears and the next instalment | [GetWorkpayAgreementsIdBalance](39_api_response_shapes.md#getworkpayagreementsidbalance) |

### B-WAP-06 · Waive fees or instalments

**As a** Branch Manager or Owner, **I want to** waive all or part of a late fee or instalment **so that** fair exceptions are on record.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/workpay/agreements/:id/instalments/:number/waive` | `workpay.penalty.waive` | Waive what is left of an instalment, or part of it | [GetWorkpayAgreementsIdBalance](39_api_response_shapes.md#getworkpayagreementsidbalance) |
| POST | `/api/v1/workpay/agreements/:id/penalties/:penaltyId/waive` | `workpay.penalty.waive` | Waive a late fee, or part of it | [GetWorkpayAgreementsIdBalance](39_api_response_shapes.md#getworkpayagreementsidbalance) |

### B-WAP-07 · Reschedule an agreement

**As a** Branch Manager or Owner, **I want to** give a payment holiday or spread what is left over a new schedule **so that** a struggling driver can recover.

*Surface: Web*

**Acceptance criteria**

- A holiday makes the term longer. A restructure takes in arrears.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/workpay/agreements/:id/payment-holiday` | `workpay.restructure` | Move the instalments due from a date some periods later (the term gets longer) | [GetWorkpayAgreementsIdBalance](39_api_response_shapes.md#getworkpayagreementsidbalance) |
| POST | `/api/v1/workpay/agreements/:id/restructure` | `workpay.restructure` | Spread what is left of the instalments, arrears included, over a new schedule | [GetWorkpayAgreementsIdBalance](39_api_response_shapes.md#getworkpayagreementsidbalance) |
| GET | `/api/v1/workpay/agreements/:id/reschedules` | `workpay.view` | Payment holidays and restructures of an agreement, newest first | [RescheduleView](39_api_response_shapes.md#rescheduleview)[] |

### B-WAP-08 · Record time off the road

**As a** Branch Manager or Owner, **I want to** mark a car off the road and back **so that** the driver is not unfairly behind.

*Surface: Web*

**Acceptance criteria**

- A holiday is suggested when the owner was at fault.
- Work orders can start and end this for you.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/workpay/agreements/:id/downtime` | `workpay.view` | Times the vehicle was off the road, with the payment holiday each suggests | [DowntimeView](39_api_response_shapes.md#downtimeview)[] |
| POST | `/api/v1/workpay/agreements/:id/downtime` | `workpay.restructure` | Take the vehicle off the road (workshop, accident …) | [DowntimeView](39_api_response_shapes.md#downtimeview) |
| POST | `/api/v1/workpay/agreements/:id/downtime/end` | `workpay.restructure` | The vehicle is back on the road (a holiday is suggested when the owner was at fault) | [DowntimeView](39_api_response_shapes.md#downtimeview) |

### B-WAP-09 · Settle early

**As a** Branch Manager, Cashier or Accountant, **I want to** see closing figures, quote a payoff and settle **so that** a driver can finish early at a clear price.

*Surface: Web*

**Acceptance criteria**

- A quote lasts the business's set days; any discount is waived at settlement.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/workpay/agreements/:id/closing-figures` | `workpay.view` | What settles the agreement today, what was paid, and the suggested repossession refund | [GetWorkpayAgreementsIdClosingFigures](39_api_response_shapes.md#getworkpayagreementsidclosingfigures) |
| POST | `/api/v1/workpay/agreements/:id/settlement-quotes` | `workpay.payment.record` | Quote the early settlement payoff (valid for the business's days) | [QuoteView3](39_api_response_shapes.md#quoteview3) |
| POST | `/api/v1/workpay/agreements/:id/settle` | `workpay.payment.record` | Pay the agreement off with a settlement quote (the discount is waived) | [PostWorkpayAgreementsIdPayments](39_api_response_shapes.md#postworkpayagreementsidpayments) |

### B-WAP-10 · End an agreement early

**As a** Branch Manager or Owner, **I want to** terminate an agreement or repossess the vehicle **so that** the business can act when it must.

*Surface: Web*

**Acceptance criteria**

- Termination covers mutual end, death or write-off, with its settlement.
- Repossession applies to agreements in arrears or defaulted, with a suggested refund.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/workpay/agreements/:id/terminate` | `workpay.terminate` | End a running agreement early (mutual, death, write-off …) with its settlement | [GetWorkpayAgreementsIdBalance](39_api_response_shapes.md#getworkpayagreementsidbalance) |
| POST | `/api/v1/workpay/agreements/:id/repossess` | `workpay.terminate` | Take the vehicle back from an agreement in arrears or defaulted | [GetWorkpayAgreementsIdBalance](39_api_response_shapes.md#getworkpayagreementsidbalance) |

### B-WAP-11 · Transfer ownership

**As a** Branch Manager, **I want to** follow the transfer letter, correct it, and track the DVLA change **so that** the driver gets the car legally.

*Surface: Web*

**Acceptance criteria**

- The letter issues automatically when paid up; ownership moves when both have signed.
- Corrections are possible until both have signed.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/workpay/agreements/:id/transfer` | `workpay.view` | The transfer of a paid-up agreement: letter, signatures, ownership, DVLA | [TransferView](39_api_response_shapes.md#transferview) |
| POST | `/api/v1/workpay/agreements/:id/transfer-letter` | `workpay.transfer.manage` | Issue the transfer letter again with corrections (until both have signed) | [TransferView](39_api_response_shapes.md#transferview) |
| PATCH | `/api/v1/workpay/agreements/:id/transfer/dvla` | `workpay.transfer.manage` | Track the DVLA change of ownership (after the transfer) | [TransferView](39_api_response_shapes.md#transferview) |
| POST | `/api/v1/workpay/agreements/:id/transfer/papers` | `workpay.transfer.manage` | Attach a DVLA form or receipt | [PostDealerAppraisalsIdPhotos](39_api_response_shapes.md#postdealerappraisalsidphotos) |
| POST | `/api/v1/workpay/agreements/:id/transfer/papers/:fileId/complete` | `workpay.transfer.manage` | Confirm a DVLA paper upload | [PostDealerAppraisalsIdPhotosFileIdComplete](39_api_response_shapes.md#postdealerappraisalsidphotosfileidcomplete) |

### B-WAP-12 · Share a statement

**As a** Branch Manager or Accountant, **I want to** view and download an agreement statement **so that** everyone sees the same figures.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/workpay/agreements/:id/statement` | `workpay.view` | The agreement statement: paid to date, outstanding, overdue, schedule, payments | [GetMeDriverWorkpayIdStatement](39_api_response_shapes.md#getmedriverworkpayidstatement) |
| GET | `/api/v1/workpay/agreements/:id/statement.pdf` | `workpay.view` | The agreement statement as a PDF | File |

### B-WAP-13 · Watch the portfolio

**As an** Owner, Branch Manager or Accountant, **I want to** see financed, collected, outstanding, PAR, ageing and the forecast, and who is behind **so that** I can act on arrears early.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/dashboards/workpay` | `dashboards.workpay.view` | Work and pay portfolio: financed, collected, outstanding, PAR 7/30/60/90, ageing, collection rate, forecast | [GetDashboardsWorkpay](39_api_response_shapes.md#getdashboardsworkpay) |
| GET | `/api/v1/dashboards/workpay/arrears` | `dashboards.workpay.view` | Agreements in arrears, longest first, with what each driver is behind | [GetDashboardsWorkpayArrearsItem](39_api_response_shapes.md#getdashboardsworkpayarrearsitem)[] |

### B-WAP-14 · Set Work & Pay defaults

**As an** Owner or Administrator, **I want to** set frequency, grace, rounding and the deposit rule **so that** new agreements start right.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/settings/workpay` | `settings.view` | Work and pay defaults | [GetSettingsWorkpay](39_api_response_shapes.md#getsettingsworkpay) |
| PATCH | `/api/v1/settings/workpay` | `workpay.settings.manage` | Change the work and pay defaults | [GetSettingsWorkpay](39_api_response_shapes.md#getsettingsworkpay) |

---

# Part 4: Rentals

## Rental set-up

### B-RSET-01 · Define vehicle classes

**As an** Owner or Administrator, **I want to** add and change the classes customers book, and place vehicles in them **so that** we sell categories, not single cars.

*Surface: Web*

**Acceptance criteria**

- Classes carry renter rules (age, licence) and a security deposit.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/vehicle-classes` | `rentals.view` | Vehicle classes customers book, with how many vehicles each has | [VehicleClassView](39_api_response_shapes.md#vehicleclassview)[] |
| POST | `/api/v1/vehicle-classes` | `rentals.rate_plans.manage` | Add a vehicle class | [PostVehicleClasses](39_api_response_shapes.md#postvehicleclasses) |
| PATCH | `/api/v1/vehicle-classes/:id` | `rentals.rate_plans.manage` | Change or deactivate a vehicle class | [PostVehicleClasses](39_api_response_shapes.md#postvehicleclasses) |
| PUT | `/api/v1/vehicles/:id/rental-class` | `vehicles.update` | Put a vehicle in a rental class (null takes it out) | [PutVehiclesIdRentalClass](39_api_response_shapes.md#putvehiclesidrentalclass) |

### B-RSET-02 · Set rates

**As an** Owner or Administrator, **I want to** manage rate plans for a class or vehicle, branch or customer **so that** every rental prices itself.

*Surface: Web*

**Acceptance criteria**

- Hourly, daily, weekend, weekly and monthly rates, mileage, chauffeur fees and seasons.
- Sending seasons replaces the plan's seasons.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/rental-rate-plans` | `rentals.view` | Rate plans, by class, vehicle or customer | [GetRentalRatePlansItem](39_api_response_shapes.md#getrentalrateplansitem)[] |
| GET | `/api/v1/rental-rate-plans/:id` | `rentals.view` | A rate plan with its seasons | [GetRentalRatePlansItem](39_api_response_shapes.md#getrentalrateplansitem) |
| POST | `/api/v1/rental-rate-plans` | `rentals.rate_plans.manage` | Add a rate plan for a class or a vehicle (optionally a branch or a customer) | [GetRentalRatePlansItem](39_api_response_shapes.md#getrentalrateplansitem) |
| PATCH | `/api/v1/rental-rate-plans/:id` | `rentals.rate_plans.manage` | Change a rate plan (seasons, when sent, replace the plan's seasons) | [GetRentalRatePlansItem](39_api_response_shapes.md#getrentalrateplansitem) |

### B-RSET-03 · Offer extras and zones

**As an** Owner or Administrator, **I want to** manage extras and delivery, collection and out-of-town zones **so that** add-ons are priced consistently.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/rental-extras` | `rentals.view` | Extras offered with rentals (child seat, GPS, insurance …) | [GetRentalExtrasItem](39_api_response_shapes.md#getrentalextrasitem)[] |
| POST | `/api/v1/rental-extras` | `rentals.rate_plans.manage` | Add an extra | [GetRentalExtrasItem](39_api_response_shapes.md#getrentalextrasitem) |
| PATCH | `/api/v1/rental-extras/:id` | `rentals.rate_plans.manage` | Change or deactivate an extra | [GetRentalExtrasItem](39_api_response_shapes.md#getrentalextrasitem) |
| GET | `/api/v1/rental-zones` | `rentals.view` | Delivery, collection and out-of-town zones | [GetRentalZonesItem](39_api_response_shapes.md#getrentalzonesitem)[] |
| POST | `/api/v1/rental-zones` | `rentals.rate_plans.manage` | Add a zone | [GetRentalZonesItem](39_api_response_shapes.md#getrentalzonesitem) |
| PATCH | `/api/v1/rental-zones/:id` | `rentals.rate_plans.manage` | Change or deactivate a zone | [GetRentalZonesItem](39_api_response_shapes.md#getrentalzonesitem) |

### B-RSET-04 · Run promotions

**As an** Owner or Administrator, **I want to** manage promo codes **so that** we can win bookings with offers.

*Surface: Web*

**Acceptance criteria**

- A percent or an amount off the rental charge; uses are counted.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/rental-promo-codes` | `rentals.rate_plans.manage` | Promo codes, newest first, with their uses | [GetRentalPromoCodesItem](39_api_response_shapes.md#getrentalpromocodesitem)[] |
| POST | `/api/v1/rental-promo-codes` | `rentals.rate_plans.manage` | Add a promo code (a percent or an amount off the rental charge) | [GetRentalPromoCodesItem](39_api_response_shapes.md#getrentalpromocodesitem) |
| PATCH | `/api/v1/rental-promo-codes/:id` | `rentals.rate_plans.manage` | Change or deactivate a promo code | [GetRentalPromoCodesItem](39_api_response_shapes.md#getrentalpromocodesitem) |

### B-RSET-05 · Keep holidays and pricing rules

**As an** Owner or Administrator, **I want to** set public holidays, weekend days, grace, tiers and the discount limit **so that** pricing is right on every date.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/public-holidays` | `rentals.view` | The business's public holidays of a year | [GetPublicHolidaysItem](39_api_response_shapes.md#getpublicholidaysitem)[] |
| POST | `/api/v1/public-holidays` | `rentals.rate_plans.manage` | Add a public holiday | [GetPublicHolidaysItem](39_api_response_shapes.md#getpublicholidaysitem) |
| DELETE | `/api/v1/public-holidays/:id` | `rentals.rate_plans.manage` | Remove a holiday entered by mistake | No body (204) |
| GET | `/api/v1/settings/rentals` | `settings.view` | Rental pricing settings (weekend days, grace, tier thresholds, discount limit) | [GetSettingsRentals](39_api_response_shapes.md#getsettingsrentals) |
| PATCH | `/api/v1/settings/rentals` | `rentals.rate_plans.manage` | Change the rental pricing settings | [GetSettingsRentals](39_api_response_shapes.md#getsettingsrentals) |

## Availability and booking

### B-RBK-01 · See the day

**As a** Rental Agent or Branch Manager, **I want to** see today's pickups, returns, overdue rentals and lapsing reservations **so that** the desk knows what is next.

*Surface: Web, Mobile*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/rental-board` | `rentals.view` | The day's pickups and returns, overdue rentals and reservations lapsing | [GetRentalBoard](39_api_response_shapes.md#getrentalboard) |

### B-RBK-02 · Find a free car

**As a** Rental Agent or Branch Manager, **I want to** search availability with prices, and see the calendar **so that** I can answer a customer at once.

*Surface: Web, Mobile*

**Acceptance criteria**

- Availability is by class at a branch for the times. The calendar shows free vehicles per class per day.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/rentals/availability` | `rentals.view` | Classes with free vehicles at a branch for the times, with their prices | [GetRentalsAvailabilityItem](39_api_response_shapes.md#getrentalsavailabilityitem)[] |
| GET | `/api/v1/rentals/calendar` | `rentals.view` | Vehicles with their bookings and blocks, and free vehicles per class per day | [GetRentalsCalendar](39_api_response_shapes.md#getrentalscalendar) |

### B-RBK-03 · Price a rental

**As a** Rental Agent or Branch Manager, **I want to** get lines, discounts, tax and totals **so that** I can quote without booking.

*Surface: Web, Mobile*

**Acceptance criteria**

- Nothing is stored.
- Discounts follow the role's `max_percent`; beyond it needs `rentals.price.override`.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/rentals/quotes` | `rentals.view` | Price a rental: lines, discounts, tax and totals (nothing is stored) | [QuotedRental](39_api_response_shapes.md#quotedrental) |

### B-RBK-04 · Hold a car

**As a** Rental Agent or Branch Manager, **I want to** hold a vehicle or the best fit of a class until it lapses **so that** a customer can decide without losing it.

*Surface: Web, Mobile*

**Acceptance criteria**

- Show when the hold lapses.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/rentals/holds` | `rentals.create` | Hold a vehicle, or the best-fit vehicle of a class, until the hold lapses | [PostRentalsHolds](39_api_response_shapes.md#postrentalsholds) |
| GET | `/api/v1/vehicle-blocks/:id` | `rentals.view` | A block of a vehicle | [PostRentalsHolds](39_api_response_shapes.md#postrentalsholds) |
| PATCH | `/api/v1/vehicle-blocks/:id` | Signed-in | Change a block's times or note | [PostRentalsHolds](39_api_response_shapes.md#postrentalsholds) |
| POST | `/api/v1/vehicle-blocks/:id/release` | Signed-in | Free the vehicle (a hold given up, maintenance done …) | [PostRentalsHolds](39_api_response_shapes.md#postrentalsholds) |

### B-RBK-05 · Book a customer

**As a** Rental Agent or Branch Manager, **I want to** reserve or book a class or vehicle, then change or confirm it **so that** the car is promised to them.

*Surface: Web, Mobile*

**Acceptance criteria**

- Age, licence, blacklist and watchlist are checked at booking and confirmation.
- A change is re-quoted and re-checked. Show the warning when a service falls due before the return.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/rentals` | `rentals.view` | Rental bookings in the caller's branches, latest pickup first | [GetRentalsItem](39_api_response_shapes.md#getrentalsitem)[] |
| POST | `/api/v1/rentals` | `rentals.create` | Reserve (or book, confirmed) a class or a vehicle for a customer | [BookingDetail](39_api_response_shapes.md#bookingdetail) |
| GET | `/api/v1/rentals/:id` | `rentals.view` | A booking with its charges and events | [BookingDetail](39_api_response_shapes.md#bookingdetail) |
| PATCH | `/api/v1/rentals/:id` | `rentals.update` | Change a booking before check-out (re-quoted and re-checked) | [BookingDetail](39_api_response_shapes.md#bookingdetail) |
| POST | `/api/v1/rentals/:id/confirm` | `rentals.update` | Confirm a reservation | [BookingDetail](39_api_response_shapes.md#bookingdetail) |

### B-RBK-06 · Swap the vehicle on a booking

**As a** Rental Agent or Branch Manager, **I want to** give a class booking another car of the class **so that** the fleet stays flexible.

*Surface: Web*

**Acceptance criteria**

- The best fit is chosen by default.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/rentals/:id/vehicle` | `rentals.create` | Give a class booking another vehicle of the class (the best fit by default) | [BookingDetail](39_api_response_shapes.md#bookingdetail) |
| POST | `/api/v1/vehicle-blocks/:id/move` | `rentals.create` | Move a class booking to another vehicle of the class (the best fit by default) | [PostRentalsHolds](39_api_response_shapes.md#postrentalsholds) |

### B-RBK-07 · Block a car from rental

**As a** Branch Manager or Fleet Officer, **I want to** take a vehicle out of rental for maintenance, transfer or sale **so that** nobody books it.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/vehicle-blocks` | `vehicles.update` | Take a vehicle out of rental (maintenance, transfer, sale hold …) | [PostVehicleBlocks](39_api_response_shapes.md#postvehicleblocks) |

### B-RBK-08 · Cancel or mark a no-show

**As a** Rental Agent or Branch Manager, **I want to** cancel a booking, or record that the customer did not come **so that** the policy fee is applied fairly.

*Surface: Web, Mobile*

**Acceptance criteria**

- Late cancellations pay the policy fee. No-show is available from the pickup time. Fees invoice at once.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/rentals/:id/cancel` | `rentals.cancel` | Cancel a booking before check-out (late cancellations pay the policy fee) | [BookingDetail](39_api_response_shapes.md#bookingdetail) |
| POST | `/api/v1/rentals/:id/no-show` | `rentals.cancel` | The customer did not come (from the pickup time; the no-show fee applies) | [BookingDetail](39_api_response_shapes.md#bookingdetail) |

## Check-out and check-in

### B-RCK-01 · Hand over a car

**As a** Rental Agent or Branch Manager, **I want to** record ID and licence seen, odometer, fuel, checklist, photos and damages **so that** the handover protects us both.

*Surface: Web, Mobile*

**Acceptance criteria**

- Photos upload first against the booking, then are referenced.
- The class deposit is required before check-out unless overridden.
- A rental agreement issues for the agent and renter to sign.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/rentals/:id/photos` | `rentals.view` | Upload a photo for the next check-out or check-in (then confirm it) | [PostDealerAppraisalsIdPhotos](39_api_response_shapes.md#postdealerappraisalsidphotos) |
| POST | `/api/v1/rentals/:id/photos/:fileId/complete` | `rentals.view` | Confirm a rental photo upload | [PostDealerAppraisalsIdPhotosFileIdComplete](39_api_response_shapes.md#postdealerappraisalsidphotosfileidcomplete) |
| POST | `/api/v1/rentals/:id/checkout` | `rentals.checkout` | Hand the vehicle over: ID and licence seen, odometer, fuel, checklist, photos, damages found | [BookingDetail](39_api_response_shapes.md#bookingdetail) |

### B-RCK-02 · Extend a rental

**As a** Rental Agent or Branch Manager, **I want to** move the return later **so that** the customer can keep the car.

*Surface: Web, Mobile*

**Acceptance criteria**

- Re-checked against the next booking and charged at the booked rates.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/rentals/:id/extend` | `rentals.update` | Move the return later (re-checked and charged at the booked rates) | [BookingDetail](39_api_response_shapes.md#bookingdetail) |

### B-RCK-03 · Take a car back

**As a** Rental Agent or Branch Manager, **I want to** record the inspection and new damages **so that** late return, mileage, fuel, cleaning and damage are charged.

*Surface: Web, Mobile*

**Acceptance criteria**

- Major damage sends the vehicle to maintenance.
- A return note issues for signature.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/rentals/:id/checkin` | `rentals.checkin` | Take the vehicle back: inspection and new damages; late return, mileage, refuelling, cleaning and damage are charged | [BookingDetail](39_api_response_shapes.md#bookingdetail) |

### B-RCK-04 · Compare inspections

**As a** Rental Agent or Branch Manager, **I want to** see what changed between check-out and check-in **so that** disputes are settled with evidence.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/rentals/:id/inspections` | `rentals.view` | Check-out and check-in inspections, what changed, the damages found and the vehicle's damage map | [GetRentalsIdInspections](39_api_response_shapes.md#getrentalsidinspections) |

### B-RCK-05 · Reissue rental papers

**As a** Rental Agent or Branch Manager, **I want to** issue the agreement or return note again **so that** changes are signed for.

*Surface: Web*

**Acceptance criteria**

- The current one is voided and signing starts again.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/rentals/:id/agreement` | `rentals.update` | Issue the rental agreement again (after an extension, a change or a mistake): the current one is voided and signing starts again | [PostRentalsIdAgreement](39_api_response_shapes.md#postrentalsidagreement) |
| POST | `/api/v1/rentals/:id/return-note` | `rentals.update` | Issue the return note again: the current one is voided and signing starts again | [PostRentalsIdAgreement](39_api_response_shapes.md#postrentalsidagreement) |

### B-RCK-06 · Close a booking

**As a** Rental Agent or Branch Manager, **I want to** close a returned booking **so that** the invoice issues and the rental is finished.

*Surface: Web*

**Acceptance criteria**

- Closing warns when documents are unsigned.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/rentals/:id/close` | `rentals.update` | Close a returned booking | [BookingDetail](39_api_response_shapes.md#bookingdetail) |

### B-RCK-07 · Manage damages

**As a** Fleet Officer or Branch Manager, **I want to** record, price, settle and repair damages with photos **so that** costs reach whoever owes them.

*Surface: Web, Mobile*

**Acceptance criteria**

- Settling keeps the renter's booking charges in step.
- Repaired damages leave the damage map.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/vehicle-damages` | `vehicles.view` | Damages of the caller's branches (a vehicle's damage map with vehicleId), newest first | [DamageView](39_api_response_shapes.md#damageview)[] |
| POST | `/api/v1/vehicle-damages` | `vehicles.damages.manage` | Record a damage noticed outside a rental | [DamageView](39_api_response_shapes.md#damageview) |
| GET | `/api/v1/vehicle-damages/:id` | `vehicles.view` | A damage with its photos | [GetVehicleDamagesId](39_api_response_shapes.md#getvehicledamagesid) |
| PATCH | `/api/v1/vehicle-damages/:id` | `vehicles.damages.manage` | Settle a damage: estimate, final cost, who pays (the renter's booking charges follow), work order and claim | [DamageView](39_api_response_shapes.md#damageview) |
| POST | `/api/v1/vehicle-damages/:id/repaired` | `vehicles.damages.manage` | Mark a damage repaired (off the damage map), with its final cost | [DamageView](39_api_response_shapes.md#damageview) |
| POST | `/api/v1/vehicle-damages/:id/photos` | `vehicles.damages.manage` | Add a photo to a damage (then confirm it) | [PostDealerAppraisalsIdPhotos](39_api_response_shapes.md#postdealerappraisalsidphotos) |
| POST | `/api/v1/vehicle-damages/:id/photos/:fileId/complete` | `vehicles.damages.manage` | Confirm a damage photo upload | [PostDealerAppraisalsIdPhotosFileIdComplete](39_api_response_shapes.md#postdealerappraisalsidphotosfileidcomplete) |

## Rental money

### B-RMNY-01 · See a booking's account

**As a** Rental Agent or Branch Manager, **I want to** see charges, invoices, balance, payments and deposit **so that** I know what is owed.

*Surface: Web, Mobile*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/rentals/:id/account` | `rentals.view` | A booking's charges, invoices, balance, payments and deposit | [GetRentalsIdAccount](39_api_response_shapes.md#getrentalsidaccount) |

### B-RMNY-02 · Take payment

**As a** Rental Agent or Branch Manager, **I want to** take a payment on a booking **so that** the renter gets a receipt and the balance updates.

*Surface: Web, Mobile*

**Acceptance criteria**

- Applied to the booking's invoices, the rest to the next one.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/rentals/:id/payments` | `rentals.payments.record` | Take a payment for the booking (applied to its invoices; the rest to the next one) | [GetRentalsIdAccount](39_api_response_shapes.md#getrentalsidaccount) |

### B-RMNY-03 · Handle the deposit

**As a** Rental Agent or Branch Manager, **I want to** take, apply and return the security deposit **so that** it is safe and accounted for.

*Surface: Web, Mobile*

**Acceptance criteria**

- Held as the customer's credit.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/rentals/:id/deposit` | `rentals.payments.record` | Take the security deposit (held as the customer's credit) | [GetRentalsIdAccount](39_api_response_shapes.md#getrentalsidaccount) |
| POST | `/api/v1/rentals/:id/deposit/apply` | `rentals.payments.record` | Apply the deposit to the booking's open invoices (all it can without an amount) | [GetRentalsIdAccount](39_api_response_shapes.md#getrentalsidaccount) |
| POST | `/api/v1/rentals/:id/deposit/release` | `rentals.payments.record` | Return what the deposit still holds to the customer | [GetRentalsIdAccount](39_api_response_shapes.md#getrentalsidaccount) |

### B-RMNY-04 · Invoice late charges

**As a** Rental Agent or Branch Manager, **I want to** invoice charges not invoiced yet **so that** late damage and fees are collected.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/rentals/:id/invoice` | `rentals.update` | Invoice the charges not invoiced yet (a later damage, a cancellation fee) | [GetRentalsIdAccount](39_api_response_shapes.md#getrentalsidaccount) |

### B-RMNY-05 · Run corporate accounts

**As a** Rental Agent or Branch Manager, **I want to** see a renter's account and manage their authorised drivers **so that** companies can rent on account.

*Surface: Web*

**Acceptance criteria**

- Shows risk, credit limit, what is owed and history. An authorised driver is an individual customer.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/customers/:id/rental-account` | `customers.view` | A renter's account: risk, credit limit and what is owed, rental history, authorised drivers | [GetCustomersIdRentalAccount](39_api_response_shapes.md#getcustomersidrentalaccount) |
| POST | `/api/v1/customers/:id/authorised-drivers` | `customers.update` | Authorise an individual customer to drive a company's rentals | [GetCustomersIdRentalAccount](39_api_response_shapes.md#getcustomersidrentalaccount) |
| DELETE | `/api/v1/customers/:id/authorised-drivers/:driverId` | `customers.update` | Withdraw a driver's authorisation | [GetCustomersIdRentalAccount](39_api_response_shapes.md#getcustomersidrentalaccount) |

### B-RMNY-06 · Read rental reports

**As an** Owner, Branch Manager or Accountant, **I want to** see utilisation, revenue, balances, deposits and damages **so that** I can run rentals by the numbers.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/dashboards/rentals/utilisation` | `dashboards.rentals.view` | Hours on rent against hours the fleet could be rented, by class and vehicle | [GetDashboardsRentalsUtilisation](39_api_response_shapes.md#getdashboardsrentalsutilisation) |
| GET | `/api/v1/dashboards/rentals/revenue` | `dashboards.rentals.view` | Rental revenue by class, branch and customer type, with the average daily rate and revenue per available vehicle | [GetDashboardsRentalsRevenue](39_api_response_shapes.md#getdashboardsrentalsrevenue) |
| GET | `/api/v1/dashboards/rentals/balances` | `dashboards.rentals.view` | What rentals still owe, and the security deposits held | [GetDashboardsRentalsBalances](39_api_response_shapes.md#getdashboardsrentalsbalances) |
| GET | `/api/v1/dashboards/rentals/damages` | `dashboards.rentals.view` | Damage costs against what the renters were charged, by liability | [GetDashboardsRentalsDamages](39_api_response_shapes.md#getdashboardsrentalsdamages) |

---

# Part 5: Keeping vehicles on the road

## Service plans

### B-MNT-01 · Plan servicing

**As an** Owner or Administrator, **I want to** add service plans from templates or my own tasks **so that** every car has a schedule.

*Surface: Web*

**Acceptance criteria**

- Target every vehicle, a make and model, a group, a rental class or one vehicle; the most specific active plan wins.
- Tasks run on km and/or days.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/service-plan-templates` | `maintenance.view` | Built-in service schedules to start a plan from | [GetServicePlanTemplatesItem](39_api_response_shapes.md#getserviceplantemplatesitem)[] |
| GET | `/api/v1/service-plans` | `maintenance.view` | Service plans with their tasks | [ServicePlanWithTasks](39_api_response_shapes.md#serviceplanwithtasks)[] |
| GET | `/api/v1/service-plans/:id` | `maintenance.view` | A service plan with its tasks | [ServicePlanWithTasks](39_api_response_shapes.md#serviceplanwithtasks) |
| POST | `/api/v1/service-plans` | `maintenance.plans.manage` | Add a service plan for every vehicle, a make (and model), a group, a rental class or one vehicle — from a template or with its own tasks | [ServicePlanWithTasks](39_api_response_shapes.md#serviceplanwithtasks) |
| PATCH | `/api/v1/service-plans/:id` | `maintenance.plans.manage` | Rename, re-target or deactivate a service plan | [ServicePlanWithTasks](39_api_response_shapes.md#serviceplanwithtasks) |
| POST | `/api/v1/service-plans/:id/tasks` | `maintenance.plans.manage` | Add a task (every so many km and/or days) to a service plan | [ServicePlanWithTasks](39_api_response_shapes.md#serviceplanwithtasks) |
| PATCH | `/api/v1/service-plan-tasks/:id` | `maintenance.plans.manage` | Change or deactivate a service plan task | [ServicePlanWithTasks](39_api_response_shapes.md#serviceplanwithtasks) |

### B-MNT-02 · See what is due

**As a** Fleet Officer or Branch Manager, **I want to** see upcoming, due and overdue services, and a vehicle's schedule **so that** nothing is missed.

*Surface: Web, Mobile*

**Acceptance criteria**

- Most pressing first.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/service-due` | `maintenance.view` | Services coming up, due and overdue across the fleet, most pressing first | [GetServiceDueItem](39_api_response_shapes.md#getservicedueitem)[] |
| GET | `/api/v1/vehicles/:id/service-schedule` | `maintenance.view` | A vehicle's service plan, every task's next due point and its service history | [GetVehiclesIdServiceSchedule](39_api_response_shapes.md#getvehiclesidserviceschedule) |

### B-MNT-03 · Record a service

**As a** Fleet Officer or Branch Manager, **I want to** record a service done **so that** the task counts again from it.

*Surface: Web, Mobile*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/vehicles/:id/services` | `maintenance.work_orders.manage` | Record a service done (the task counts again from it) | [PostVehiclesIdServices](39_api_response_shapes.md#postvehiclesidservices) |

### B-MNT-04 · Read maintenance KPIs

**As an** Owner, Branch Manager or Fleet Officer, **I want to** see cost, downtime, availability and failures, and compliance **so that** I can spot bad cars and bad habits.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/dashboards/maintenance` | `dashboards.maintenance.view` | Maintenance cost by kind, type, vehicle and model with cost per km, downtime and availability, preventive against corrective work, mean time between failures and services due | [GetDashboardsMaintenance](39_api_response_shapes.md#getdashboardsmaintenance) |
| GET | `/api/v1/dashboards/compliance` | `dashboards.maintenance.view` | Vehicles red, amber or green on documents, services and fines, and drivers' licences expired or expiring within `days` (default 30) | [GetDashboardsCompliance](39_api_response_shapes.md#getdashboardscompliance) |

## Work orders

### B-WOR-01 · Open and follow work orders

**As a** Fleet Officer or Branch Manager, **I want to** list, open and change work orders **so that** every job is tracked.

*Surface: Web, Mobile*

**Acceptance criteria**

- Can come from an issue, a damage or service tasks. Going off the road blocks rentals and pauses Work & Pay.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/work-orders` | `maintenance.view` | Work orders, newest first (`open=true` for those not done) | [WorkOrderView](39_api_response_shapes.md#workorderview)[] |
| GET | `/api/v1/work-orders/:id` | `maintenance.view` | A work order with its lines, who pays and the downtime | [WorkOrderView](39_api_response_shapes.md#workorderview) |
| POST | `/api/v1/work-orders` | `maintenance.work_orders.manage` | Open a work order on a vehicle (optionally off the road: rentals blocked, Work & Pay paused) | [WorkOrderView](39_api_response_shapes.md#workorderview) |
| PATCH | `/api/v1/work-orders/:id` | `maintenance.work_orders.manage` | Change an open work order (the expected return moves its block) | [WorkOrderView](39_api_response_shapes.md#workorderview) |
| PUT | `/api/v1/work-orders/:id/lines` | `maintenance.work_orders.manage` | Replace the labour, parts, sublet and other lines | [WorkOrderView](39_api_response_shapes.md#workorderview) |

### B-WOR-02 · Move a job along

**As a** Fleet Officer or Branch Manager, **I want to** start, wait for parts, go off road, or cancel **so that** the status is honest.

*Surface: Web, Mobile*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/work-orders/:id/start` | `maintenance.work_orders.manage` | Work has started | [WorkOrderView](39_api_response_shapes.md#workorderview) |
| POST | `/api/v1/work-orders/:id/awaiting-parts` | `maintenance.work_orders.manage` | Waiting for parts | [WorkOrderView](39_api_response_shapes.md#workorderview) |
| POST | `/api/v1/work-orders/:id/off-road` | `maintenance.work_orders.manage` | Take the vehicle off the road for the job | [WorkOrderView](39_api_response_shapes.md#workorderview) |
| POST | `/api/v1/work-orders/:id/cancel` | `maintenance.work_orders.manage` | Cancel an open work order (the vehicle back on the road) | [WorkOrderView](39_api_response_shapes.md#workorderview) |

### B-WOR-03 · Complete a job

**As a** Fleet Officer or Branch Manager, **I want to** record the odometer, tasks done, damage repaired and who pays **so that** costs post correctly.

*Surface: Web, Mobile*

**Acceptance criteria**

- The business pays the rest after the driver's, renter's or insurer's share.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/work-orders/:id/complete` | `maintenance.work_orders.manage` | Complete: odometer, service tasks done, damage repaired, costs posted with who pays | [WorkOrderView](39_api_response_shapes.md#workorderview) |

### B-WOR-04 · Judge a vendor

**As a** Fleet Officer or Branch Manager, **I want to** see a vendor's jobs, spend, turnaround and rating **so that** we use good workshops.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/suppliers/:id/work-orders` | `maintenance.view` | A vendor's record: jobs, spend, turnaround, rating and recent work orders | [GetSuppliersIdWorkOrders](39_api_response_shapes.md#getsuppliersidworkorders) |

## Parts

### B-PRT-01 · Keep the catalogue

**As a** Fleet Officer or Branch Manager, **I want to** find, add and change parts **so that** mechanics use the right ones.

*Surface: Web*

**Acceptance criteria**

- `vehicleId` shows the parts that fit.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/parts` | `maintenance.view` | The parts catalogue (`vehicleId`: the parts that fit it) | [GetPartsItem](39_api_response_shapes.md#getpartsitem)[] |
| POST | `/api/v1/parts` | `parts.manage` | Add a part to the catalogue | [GetPartsItem](39_api_response_shapes.md#getpartsitem) |
| GET | `/api/v1/parts/:id` | `maintenance.view` | A part with its stock at each branch | [GetPartsId](39_api_response_shapes.md#getpartsid) |
| PATCH | `/api/v1/parts/:id` | `parts.manage` | Change a part (inactive: no longer stocked) | [GetPartsItem](39_api_response_shapes.md#getpartsitem) |

### B-PRT-02 · Manage stock

**As a** Fleet Officer or Branch Manager, **I want to** set levels and bins, record opening stock, receipts, counts and transfers **so that** stock is known and never runs out unnoticed.

*Surface: Web, Mobile*

**Acceptance criteria**

- `low=true` lists stock at or below reorder level.
- Stock is held at weighted average cost per branch.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/part-stock` | `maintenance.view` | Stock by part and branch with its value (`low=true`: at or below reorder level) | [StockView](39_api_response_shapes.md#stockview)[] |
| PUT | `/api/v1/parts/:id/stock/:branchId` | `parts.manage` | The reorder level and quantity and the bin of a part at a branch | [StockView](39_api_response_shapes.md#stockview) |
| POST | `/api/v1/parts/:id/stock/:branchId/opening` | `parts.manage` | Opening stock already on the shelf (against equity) | [StockView](39_api_response_shapes.md#stockview) |
| POST | `/api/v1/parts/:id/stock/:branchId/receipts` | `parts.manage` | Bought for stock: in at its cost, an expense to the supplier posted to the inventory | [PostPartsIdStockBranchIdReceipts](39_api_response_shapes.md#postpartsidstockbranchidreceipts) |
| POST | `/api/v1/parts/:id/stock/:branchId/counts` | `parts.manage` | A stock count: the stock set to what is on the shelf (the difference to stock adjustments) | [StockView](39_api_response_shapes.md#stockview) |
| POST | `/api/v1/parts/:id/transfers` | `parts.manage` | Move stock from one branch to another at the sending branch's average cost | any[] |
| GET | `/api/v1/part-moves` | `maintenance.view` | Stock moves, newest first | [MoveView](39_api_response_shapes.md#moveview)[] |

## Incidents, claims, offences and fuel

### B-INC-01 · Report an incident

**As a** Fleet Officer or Branch Manager, **I want to** record, change, close and reopen incidents **so that** harm to a vehicle is followed through.

*Surface: Web, Mobile*

**Acceptance criteria**

- The vehicle moves to accident, stolen or impounded unless a module holds it, and goes back on closing.
- The driver at the time comes from the assignment.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/incidents` | `incidents.view` | Incidents, newest first | [GetIncidentsItem](39_api_response_shapes.md#getincidentsitem)[] |
| POST | `/api/v1/incidents` | `incidents.manage` | Report an incident (the vehicle put in accident, stolen or impounded unless a module holds it) | [IncidentView](39_api_response_shapes.md#incidentview) |
| GET | `/api/v1/incidents/:id` | `incidents.view` | An incident with its claims and what it cost (work orders, expenses, recoveries) | [IncidentView](39_api_response_shapes.md#incidentview) |
| PATCH | `/api/v1/incidents/:id` | `incidents.manage` | Change an open incident | [IncidentView](39_api_response_shapes.md#incidentview) |
| POST | `/api/v1/incidents/:id/close` | `incidents.manage` | Close with the outcome (a vehicle it moved goes back) | [IncidentView](39_api_response_shapes.md#incidentview) |
| POST | `/api/v1/incidents/:id/reopen` | `incidents.manage` | Reopen a closed incident | [IncidentView](39_api_response_shapes.md#incidentview) |
| POST | `/api/v1/incidents/:id/links` | `incidents.manage` | Count a work order or an expense of the vehicle in the incident's cost | [IncidentView](39_api_response_shapes.md#incidentview) |

### B-INC-02 · Run an insurance claim

**As a** Fleet Officer or Branch Manager, **I want to** claim, and record approval, rejection, withdrawal or settlement **so that** money due from insurers is collected.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/insurance-claims` | `incidents.view` | Insurance claims, newest first | [ClaimView](39_api_response_shapes.md#claimview)[] |
| POST | `/api/v1/incidents/:id/claims` | `incidents.manage` | Claim on an insurer (a supplier) for the incident | [IncidentView](39_api_response_shapes.md#incidentview) |
| POST | `/api/v1/insurance-claims/:id/approve` | `incidents.manage` | The insurer approved an amount | [IncidentView](39_api_response_shapes.md#incidentview) |
| POST | `/api/v1/insurance-claims/:id/reject` | `incidents.manage` | The insurer rejected the claim | [IncidentView](39_api_response_shapes.md#incidentview) |
| POST | `/api/v1/insurance-claims/:id/withdraw` | `incidents.manage` | Withdraw the claim | [IncidentView](39_api_response_shapes.md#incidentview) |
| POST | `/api/v1/insurance-claims/:id/settle` | `incidents.manage` | The insurer paid: the money received posted to insurance recoveries | [IncidentView](39_api_response_shapes.md#incidentview) |

### B-INC-03 · Handle traffic offences

**As a** Fleet Officer or Branch Manager, **I want to** record a fine and settle, contest or waive it **so that** fines reach the right driver.

*Surface: Web, Mobile*

**Acceptance criteria**

- The driver who had the car is told by SMS.
- Paid by the business (charged to the driver when they pay) or by the driver.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/traffic-offences` | `incidents.view` | Traffic offences, newest first (`outstanding=true`: unpaid or contested) | [OffenceView](39_api_response_shapes.md#offenceview)[] |
| POST | `/api/v1/traffic-offences` | `incidents.manage` | Record a traffic offence (the driver who had the vehicle is told by SMS) | [OffenceView](39_api_response_shapes.md#offenceview) |
| GET | `/api/v1/traffic-offences/:id` | `incidents.view` | A traffic offence | [OffenceView](39_api_response_shapes.md#offenceview) |
| PATCH | `/api/v1/traffic-offences/:id` | `incidents.manage` | Change an outstanding offence | [OffenceView](39_api_response_shapes.md#offenceview) |
| POST | `/api/v1/traffic-offences/:id/pay` | `incidents.manage` | Paid by the business (an expense, charged to the driver when they pay) or by the driver | [OffenceView](39_api_response_shapes.md#offenceview) |
| POST | `/api/v1/traffic-offences/:id/contest` | `incidents.manage` | Contest the fine | [OffenceView](39_api_response_shapes.md#offenceview) |
| POST | `/api/v1/traffic-offences/:id/waive` | `incidents.manage` | The fine was waived | [OffenceView](39_api_response_shapes.md#offenceview) |

### B-INC-04 · Review fuel anomalies

**As a** Fleet Officer or Branch Manager, **I want to** confirm or dismiss fills that look wrong **so that** fuel theft is caught.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/fuel-anomalies` | `incidents.view` | Fuel fills that look wrong, newest first | [GetFuelAnomaliesItem](39_api_response_shapes.md#getfuelanomaliesitem)[] |
| POST | `/api/v1/fuel-anomalies/:id/review` | `incidents.manage` | Confirmed or dismissed, with what was found | [GetFuelAnomaliesItem](39_api_response_shapes.md#getfuelanomaliesitem) |

## Telematics and GPS

### B-TEL-01 · See the fleet on a map

**As a** Fleet Officer or Branch Manager, **I want to** see every tracked vehicle as moving, idling, parked or offline **so that** I know where the fleet is.

*Surface: Web, Mobile*

**Acceptance criteria**

- The product has no map of its own: use a map library on the client.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/telematics/live` | `telematics.view` | Every tracked vehicle's last position: moving, idling, parked or offline | [LiveVehicle](39_api_response_shapes.md#livevehicle)[] |

### B-TEL-02 · Replay a vehicle

**As a** Fleet Officer or Branch Manager, **I want to** see tracks and trips **so that** I can check where a car went.

*Surface: Web*

**Acceptance criteria**

- Tracks cover up to 7 days, thinned to 5,000 points.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/vehicles/:id/track` | `telematics.view` | A vehicle's positions over up to 7 days (thinned to 5,000 points) | [GetVehiclesIdTrackItem](39_api_response_shapes.md#getvehiclesidtrackitem)[] |
| GET | `/api/v1/telematics/trips` | `telematics.view` | Trips, newest first (ignition on to off) | [GetTelematicsTripsItem](39_api_response_shapes.md#gettelematicstripsitem)[] |

### B-TEL-03 · Act on events

**As a** Fleet Officer or Branch Manager, **I want to** see geofence and over-speed events and acknowledge them with a note **so that** alerts are dealt with.

*Surface: Web, Mobile*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/telematics/events` | `telematics.view` | Geofence and over-speed events (open=true: not acknowledged) | [GetTelematicsEventsItem](39_api_response_shapes.md#gettelematicseventsitem)[] |
| POST | `/api/v1/telematics/events/:id/acknowledge` | `telematics.events.manage` | Acknowledge an event (with a note of what was done) | [GetTelematicsEventsItem](39_api_response_shapes.md#gettelematicseventsitem) |

### B-TEL-04 · See utilisation

**As a** Fleet Officer or Branch Manager, **I want to** see engine, moving and idle hours and distance **so that** I know which cars earn their keep.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/telematics/utilisation` | `telematics.view` | Engine, moving and idle hours, distance, trips and utilisation per vehicle (default: the last 30 days) | [GetTelematicsUtilisation](39_api_response_shapes.md#gettelematicsutilisation) |

### B-TEL-05 · Connect a tracking provider

**As an** Owner or Administrator, **I want to** add a connection and manage its token **so that** positions flow in.

*Surface: Web*

**Acceptance criteria**

- The token is shown once: make the user copy it. Rotating stops the old token at once.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/telematics/connections` | `telematics.manage` | Telematics provider connections | [GetTelematicsConnectionsItem](39_api_response_shapes.md#gettelematicsconnectionsitem)[] |
| GET | `/api/v1/telematics/connections/:id` | `telematics.manage` | A connection with its ingestion address | [GetTelematicsConnectionsId](39_api_response_shapes.md#gettelematicsconnectionsid) |
| POST | `/api/v1/telematics/connections` | `telematics.manage` | Connect a provider: the address and the token to give it (shown once) | [PostTelematicsConnections](39_api_response_shapes.md#posttelematicsconnections) |
| PATCH | `/api/v1/telematics/connections/:id` | `telematics.manage` | Rename a connection, or disable it (its positions are refused) and enable it again | [GetTelematicsConnectionsItem](39_api_response_shapes.md#gettelematicsconnectionsitem) |
| POST | `/api/v1/telematics/connections/:id/rotate-token` | `telematics.manage` | A new token for the connection; the old one stops working at once | [PostTelematicsConnections](39_api_response_shapes.md#posttelematicsconnections) |

### B-TEL-06 · Link trackers

**As an** Owner or Administrator, **I want to** add trackers and link each to a vehicle **so that** positions mean something.

*Surface: Web*

**Acceptance criteria**

- `unlinked=true` shows trackers seen but not on a vehicle.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/telematics/devices` | `telematics.view` | Trackers (unlinked=true: seen but not on a vehicle yet) | [GetTelematicsDevicesItem](39_api_response_shapes.md#gettelematicsdevicesitem)[] |
| GET | `/api/v1/telematics/devices/:id` | `telematics.view` | A tracker with its last position | [GetTelematicsDevicesItem](39_api_response_shapes.md#gettelematicsdevicesitem) |
| POST | `/api/v1/telematics/devices` | `telematics.manage` | Add a tracker before it first reports, on a vehicle or not | [GetTelematicsDevicesItem](39_api_response_shapes.md#gettelematicsdevicesitem) |
| PATCH | `/api/v1/telematics/devices/:id` | `telematics.manage` | Link a tracker to a vehicle (or unlink it), label it, set its odometer or retire it | [GetTelematicsDevicesItem](39_api_response_shapes.md#gettelematicsdevicesitem) |

### B-TEL-07 · Draw geofences

**As an** Owner or Administrator, **I want to** draw a circle or polygon alerting on entry, exit or both **so that** I hear when cars go where they should not.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/telematics/geofences` | `telematics.view` | Geofences | [GeofenceView](39_api_response_shapes.md#geofenceview)[] |
| GET | `/api/v1/telematics/geofences/:id` | `telematics.view` | A geofence | [GeofenceView](39_api_response_shapes.md#geofenceview) |
| POST | `/api/v1/telematics/geofences` | `telematics.manage` | Draw a geofence: a circle or a polygon, alerting on entry, exit or both | [GeofenceView](39_api_response_shapes.md#geofenceview) |
| PUT | `/api/v1/telematics/geofences/:id` | `telematics.manage` | Change or switch off a geofence | [GeofenceView](39_api_response_shapes.md#geofenceview) |

### B-TEL-08 · Set tracking rules

**As an** Owner or Administrator, **I want to** set the speed limit, retention, working day and silence alert **so that** alerts fit my fleet.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/telematics/settings` | `telematics.view` | Speed limit, retention of positions, working day and silence alert | [GetTelematicsSettings](39_api_response_shapes.md#gettelematicssettings) |
| PUT | `/api/v1/telematics/settings` | `telematics.manage` | Set the speed limit, retention of positions, working day and silence alert | [GetTelematicsSettings](39_api_response_shapes.md#gettelematicssettings) |

### B-TEL-09 · Push positions (system)

**As a** tracking provider, **I want to** post positions with the connection's token **so that** Autoforce sees the fleet.

*Surface: None (server to server)*

**Acceptance criteria**

- Our generic JSON, Flespi and Traccar formats are read. No screen is needed.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/webhooks/telematics/:tenant/:connectionId` | Public | A telematics provider pushes positions (Authorization: Bearer <the connection's token>) | [PostWebhooksTelematicsTenantConnectionId](39_api_response_shapes.md#postwebhookstelematicstenantconnectionid) |

---

# Part 6: Money

## Expenses

### B-EXP-01 · Enter an expense

**As a** Branch Manager, Fleet Officer or Accountant, **I want to** enter, correct and submit an expense, split across vehicles **so that** costs reach the right car.

*Surface: Web, Mobile*

**Acceptance criteria**

- Any enabled currency, frozen at the rate of the expense date.
- `own` scope sees only what the user entered.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/expenses` | `expenses.list` | Expenses you may see (yours only with own scope), newest first | [ExpenseView](39_api_response_shapes.md#expenseview)[] |
| POST | `/api/v1/expenses` | `expenses.create` | Enter an expense (a draft; split across vehicles if shared) | [PostExpenses](39_api_response_shapes.md#postexpenses) |
| GET | `/api/v1/expenses/:id` | `expenses.view` | An expense with its split and receipts | [ExpenseView](39_api_response_shapes.md#expenseview) |
| PUT | `/api/v1/expenses/:id` | `expenses.create` | Correct a draft or rejected expense | [PostExpenses](39_api_response_shapes.md#postexpenses) |
| DELETE | `/api/v1/expenses/:id` | `expenses.create` | Delete a draft | No body (204) |
| POST | `/api/v1/expenses/:id/submit` | `expenses.create` | Submit for approval (a matching rule may approve it) | [ExpenseView](39_api_response_shapes.md#expenseview) |
| GET | `/api/v1/expense-categories` | Signed-in | Expense categories as a tree | [ExpenseCategoryNode](39_api_response_shapes.md#expensecategorynode)[] |

### B-EXP-02 · Attach receipts

**As a** Branch Manager, Fleet Officer or Accountant, **I want to** add and remove receipts **so that** every cost has proof.

*Surface: Web, Mobile*

**Acceptance criteria**

- Removal is for drafts and rejected expenses.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/expenses/:id/receipts` | `expenses.create` | Attach a receipt scan or photo | [PostDealerAppraisalsIdPhotos](39_api_response_shapes.md#postdealerappraisalsidphotos) |
| POST | `/api/v1/expenses/:id/receipts/:fileId/complete` | `expenses.create` | Confirm a receipt upload | [PostDealerAppraisalsIdPhotosFileIdComplete](39_api_response_shapes.md#postdealerappraisalsidphotosfileidcomplete) |
| DELETE | `/api/v1/expenses/:id/receipts/:fileId` | `expenses.create` | Remove a receipt (drafts and rejected expenses) | No body (204) |

### B-EXP-03 · Scan a receipt first

**As a** Branch Manager, Fleet Officer or Accountant, **I want to** photograph a receipt and have the expense filled in **so that** entry is quick.

*Surface: Web, Mobile*

**Acceptance criteria**

- Start, upload, read, then poll for the figures; attach the scan once entered.
- A scan left unattached is cleared after 7 days.
- A reading never changes an expense or the books; show it as a suggestion.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/receipt-readings` | `expenses.create` | Scan a receipt before entering the expense: start its upload | [PostReceiptReadings](39_api_response_shapes.md#postreceiptreadings) |
| POST | `/api/v1/receipt-readings/:id/complete` | `expenses.create` | The scan is uploaded: read it | [ReceiptReadingView](39_api_response_shapes.md#receiptreadingview) |
| GET | `/api/v1/receipt-readings/:id` | `expenses.create` | Your scan: the figures to fill the expense in with, once read | [ReceiptReadingView](39_api_response_shapes.md#receiptreadingview) |
| POST | `/api/v1/receipt-readings/:id/attach` | `expenses.create` | Attach the scanned receipt to the expense entered from it | [ReceiptReadingView](39_api_response_shapes.md#receiptreadingview) |

### B-EXP-04 · Check a receipt against its expense

**As an** Accountant or Branch Manager, **I want to** read an attached receipt and see where it disagrees **so that** mistakes are caught.

*Surface: Web*

**Acceptance criteria**

- Warnings cover amount, currency and date.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/expenses/:id/receipts/:fileId/reading` | `expenses.create` | Read a receipt attached to an expense (again, if it was read before) | [ReceiptReadingView](39_api_response_shapes.md#receiptreadingview) |
| GET | `/api/v1/expenses/:id/receipts/:fileId/reading` | `expenses.view` | What the receipt says, and where it disagrees with the expense | [ReceiptReadingView](39_api_response_shapes.md#receiptreadingview) |

### B-EXP-05 · Switch receipt reading on

**As an** Owner or Administrator, **I want to** turn it on or off and set a monthly limit **so that** I control AI use and cost.

*Surface: Web*

**Acceptance criteria**

- Tell the user receipts go to an outside AI provider. It is off until switched on; the default limit is 500 a month.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/settings/receipt-reading` | `settings.view` | Whether receipts are read, the monthly limit and how much of it is used | [GetSettingsReceiptReading](39_api_response_shapes.md#getsettingsreceiptreading) |
| PUT | `/api/v1/settings/receipt-reading` | `settings.update` | Switch reading on or off (receipts go to an outside AI provider) and set the limit | [GetSettingsReceiptReading](39_api_response_shapes.md#getsettingsreceiptreading) |

### B-EXP-06 · Approve expenses

**As a** Branch Manager or Accountant, **I want to** approve or reject with a reason **so that** spending is controlled.

*Surface: Web, Mobile*

**Acceptance criteria**

- The approver is not the submitter and works within their limit. A rejected expense can be corrected and resubmitted.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/expenses/:id/approve` | `expenses.approve` | Approve (someone else than the submitter, within your limit) | [ExpenseView](39_api_response_shapes.md#expenseview) |
| POST | `/api/v1/expenses/:id/reject` | `expenses.approve` | Reject with a reason (it can be corrected and resubmitted) | [ExpenseView](39_api_response_shapes.md#expenseview) |

### B-EXP-07 · Pay or void an expense

**As a** Cashier, Branch Manager or Accountant, **I want to** pay an approved expense, or void an unpaid one **so that** the books stay right.

*Surface: Web*

**Acceptance criteria**

- Voiding an approved expense reverses it in the ledger.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/expenses/:id/pay` | `expenses.pay` | Pay an approved expense (records the payment out) | [ExpenseView](39_api_response_shapes.md#expenseview) |
| POST | `/api/v1/expenses/:id/void` | `expenses.void` | Void an unpaid expense (an approved one is reversed in the ledger) | [ExpenseView](39_api_response_shapes.md#expenseview) |

### B-EXP-08 · Record fuel

**As a** Fleet Officer or Branch Manager, **I want to** record a fill and see efficiency **so that** fuel cost and km are tracked.

*Surface: Web, Mobile*

**Acceptance criteria**

- Creates the expense and an odometer reading. Far-below-usual efficiency is flagged.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/vehicles/:id/fuel` | `expenses.fuel.record` | Record a fuel fill (creates the fuel expense and an odometer reading) | [PostMeDriverFuel](39_api_response_shapes.md#postmedriverfuel) |
| GET | `/api/v1/vehicles/:id/fuel` | `vehicles.view` | Fuel fills with efficiency between full tanks (flagged when far below usual) | [GetVehiclesIdFuel](39_api_response_shapes.md#getvehiclesidfuel) |

### B-EXP-09 · Set approval rules

**As an** Accountant or Owner, **I want to** manage rules and expense settings **so that** only what needs review waits for a person.

*Surface: Web*

**Acceptance criteria**

- The first match by priority decides.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/expense-approval-rules` | `expenses.rules.manage` | Approval rules (the first match by priority decides) | [GetExpenseApprovalRulesItem](39_api_response_shapes.md#getexpenseapprovalrulesitem)[] |
| POST | `/api/v1/expense-approval-rules` | `expenses.rules.manage` | Add an approval rule | [GetExpenseApprovalRulesItem](39_api_response_shapes.md#getexpenseapprovalrulesitem) |
| PUT | `/api/v1/expense-approval-rules/:id` | `expenses.rules.manage` | Change an approval rule | [GetExpenseApprovalRulesItem](39_api_response_shapes.md#getexpenseapprovalrulesitem) |
| DELETE | `/api/v1/expense-approval-rules/:id` | `expenses.rules.manage` | Retire an approval rule | No body (204) |
| GET | `/api/v1/settings/expenses` | `settings.view` | Expense settings (receipt threshold, fuel category) | [GetSettingsExpenses](39_api_response_shapes.md#getsettingsexpenses) |
| PATCH | `/api/v1/settings/expenses` | `expenses.rules.manage` | Change the expense settings | [GetSettingsExpenses](39_api_response_shapes.md#getsettingsexpenses) |

### B-EXP-10 · Manage categories

**As an** Owner or Administrator, **I want to** add, rename, move and deactivate categories **so that** reports read well.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/expense-categories` | `expenses.categories.manage` | Add an expense category (or a subcategory) | [PostExpenseCategories](39_api_response_shapes.md#postexpensecategories) |
| PATCH | `/api/v1/expense-categories/:id` | `expenses.categories.manage` | Rename, move, reorder or (de)activate an expense category | [PostExpenseCategories](39_api_response_shapes.md#postexpensecategories) |

### B-EXP-11 · Set budgets

**As an** Accountant or Owner, **I want to** set monthly budgets and see spending **so that** overspending shows early.

*Surface: Web*

**Acceptance criteria**

- By category, branch and/or vehicle. 80% warns; 100% is exceeded.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/budgets` | `expenses.budgets.view` | Budgets with spending for a month (80% warns, 100% exceeded) | [GetBudgetsItem](39_api_response_shapes.md#getbudgetsitem)[] |
| POST | `/api/v1/budgets` | `expenses.budgets.manage` | Add a monthly budget (by category, branch and/or vehicle) | [PostBudgets](39_api_response_shapes.md#postbudgets) |
| PUT | `/api/v1/budgets/:id` | `expenses.budgets.manage` | Change a budget | [PostBudgets](39_api_response_shapes.md#postbudgets) |
| DELETE | `/api/v1/budgets/:id` | `expenses.budgets.manage` | Remove a budget | No body (204) |

### B-EXP-12 · Automate recurring costs

**As an** Accountant or Owner, **I want to** set up recurring expenses **so that** rent and insurance are not forgotten.

*Surface: Web*

**Acceptance criteria**

- A daily job creates them when due. Removing one keeps its expenses.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/recurring-expenses` | `expenses.recurring.manage` | Recurring expenses | [RecurringView](39_api_response_shapes.md#recurringview)[] |
| POST | `/api/v1/recurring-expenses` | `expenses.recurring.manage` | Set up a recurring expense (created by the daily job when due) | [RecurringView](39_api_response_shapes.md#recurringview) |
| PUT | `/api/v1/recurring-expenses/:id` | `expenses.recurring.manage` | Change a recurring expense | [RecurringView](39_api_response_shapes.md#recurringview) |
| DELETE | `/api/v1/recurring-expenses/:id` | `expenses.recurring.manage` | Remove a recurring expense (its expenses stay) | No body (204) |

## Invoices, payments and cash

All payments are records of money received or paid. The system does not move a business's money.

### B-FIN-01 · Invoice a customer

**As an** Accountant or Branch Manager, **I want to** draft, replace, delete and issue invoices **so that** customers are billed properly.

*Surface: Web*

**Acceptance criteria**

- Tax comes from the business's codes. Issuing numbers, snapshots tax and posts.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/invoices` | `finance.invoices.view` | Invoices in your branches, newest first | [InvoiceView2](39_api_response_shapes.md#invoiceview2)[] |
| POST | `/api/v1/invoices` | `finance.invoices.manage` | Draft an invoice (tax from the business's tax codes) | [InvoiceView2](39_api_response_shapes.md#invoiceview2) |
| GET | `/api/v1/invoices/:id` | `finance.invoices.view` | An invoice with lines and tax breakdown | [InvoiceView2](39_api_response_shapes.md#invoiceview2) |
| PUT | `/api/v1/invoices/:id` | `finance.invoices.manage` | Replace a draft invoice | [InvoiceView2](39_api_response_shapes.md#invoiceview2) |
| DELETE | `/api/v1/invoices/:id` | `finance.invoices.manage` | Delete a draft invoice | No body (204) |
| POST | `/api/v1/invoices/:id/issue` | `finance.invoices.manage` | Issue a draft: number it, snapshot its tax, post it | [InvoiceView2](39_api_response_shapes.md#invoiceview2) |

### B-FIN-02 · Void an invoice

**As an** Accountant or Owner, **I want to** void an issued invoice with no payments **so that** mistakes are corrected openly.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/invoices/:id/void` | `finance.invoices.void` | Void an issued invoice without payments (posts the reversal) | [InvoiceView2](39_api_response_shapes.md#invoiceview2) |

### B-FIN-03 · Record a payment

**As a** Cashier, Accountant or Branch Manager, **I want to** record cash, MoMo, bank, cheque or card received or made **so that** every cedi is accounted for.

*Surface: Web, Mobile*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/payments` | `finance.payments.view` | Recorded payments in your branches, newest first | [PaymentView](39_api_response_shapes.md#paymentview)[] |
| POST | `/api/v1/payments` | `finance.payments.record` | Record a payment received or made (cash, MoMo, bank, cheque, card) | [PaymentView](39_api_response_shapes.md#paymentview) |
| GET | `/api/v1/payments/:id` | `finance.payments.view` | A payment with its allocations | [PaymentView](39_api_response_shapes.md#paymentview) |

### B-FIN-04 · Give a receipt

**As a** Cashier or Accountant, **I want to** show or print a receipt **so that** the payer has proof.

*Surface: Web, Mobile*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/payments/:id/receipt` | `finance.payments.view` | The receipt of money received (data; the PDF comes with P2-10) | [GetPaymentsIdReceipt](39_api_response_shapes.md#getpaymentsidreceipt) |
| GET | `/api/v1/payments/:id/receipt.pdf` | `finance.payments.view` | The receipt of money received, as PDF | File |

### B-FIN-05 · Apply credit

**As a** Cashier or Accountant, **I want to** apply part of a payment to an invoice of the same party **so that** credit is used.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/payments/:id/allocations` | `finance.payments.record` | Apply part of a payment (credit) to an invoice of the same party | [PaymentView](39_api_response_shapes.md#paymentview) |

### B-FIN-06 · Undo a payment

**As an** Accountant or Owner, **I want to** release an allocation or reverse a payment **so that** mistakes are corrected.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/payments/:id/allocations/:allocationId/release` | `finance.payments.reverse` | Release an allocation (the money becomes credit again) | [PaymentView](39_api_response_shapes.md#paymentview) |
| POST | `/api/v1/payments/:id/reverse` | `finance.payments.reverse` | Reverse a payment recorded by mistake | [PaymentView](39_api_response_shapes.md#paymentview) |

### B-FIN-07 · Run a cash till

**As a** Cashier, Branch Manager or Accountant, **I want to** open a session with a float, count and close it **so that** the till balances each shift.

*Surface: Web*

**Acceptance criteria**

- The variance is posted on closing. `finance.cash_sessions.view` sees and closes others' sessions.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/cash-sessions` | `finance.cash_sessions.manage` | Open your cash session with a float | [CashSessionView](39_api_response_shapes.md#cashsessionview) |
| GET | `/api/v1/cash-sessions/current` | `finance.cash_sessions.manage` | Your open cash session (null when none) | [CashSessionView](39_api_response_shapes.md#cashsessionview) / null |
| GET | `/api/v1/cash-sessions` | `finance.cash_sessions.manage` | Cash sessions (yours, or every session of the branches you supervise) | [CashSessionView](39_api_response_shapes.md#cashsessionview)[] |
| GET | `/api/v1/cash-sessions/:id` | `finance.cash_sessions.manage` | A cash session | [CashSessionView](39_api_response_shapes.md#cashsessionview) |
| POST | `/api/v1/cash-sessions/:id/close` | `finance.cash_sessions.manage` | Count the cash and close the session (the variance is posted) | [CashSessionView](39_api_response_shapes.md#cashsessionview) |

### B-FIN-08 · Set finance options

**As an** Accountant or Owner, **I want to** set cash session and payment term options **so that** finance follows our practice.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/settings/finance` | `settings.view` | Finance settings (cash sessions, payment terms) | [GetSettingsFinance](39_api_response_shapes.md#getsettingsfinance) |
| PATCH | `/api/v1/settings/finance` | `finance.settings.manage` | Change the finance settings | [GetSettingsFinance](39_api_response_shapes.md#getsettingsfinance) |

### B-FIN-09 · See the books

**As an** Accountant or Owner, **I want to** see the chart of accounts, trial balance, ledger lines and integrity check **so that** I can trust the numbers.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/ledger/accounts` | `finance.ledger.view` | Chart of accounts with balances | [AccountBalanceView](39_api_response_shapes.md#accountbalanceview)[] |
| POST | `/api/v1/ledger/accounts` | `finance.accounts.manage` | Add an account (e.g. a separate income line) | [PostLedgerAccounts](39_api_response_shapes.md#postledgeraccounts) |
| GET | `/api/v1/ledger/trial-balance` | `finance.ledger.view` | Trial balance (debits always equal credits) | [GetLedgerTrialBalance](39_api_response_shapes.md#getledgertrialbalance) |
| GET | `/api/v1/ledger/integrity` | `finance.ledger.view` | Check the books: entries balanced, allocations add up, work and pay sub-ledgers agree with the ledger | [GetLedgerIntegrity](39_api_response_shapes.md#getledgerintegrity) |
| GET | `/api/v1/ledger/lines` | `finance.ledger.view` | Ledger lines by account, party, vehicle, branch or period, newest first | [GetLedgerLinesItem](39_api_response_shapes.md#getledgerlinesitem)[] |

### B-FIN-10 · See a party's account

**As an** Accountant or Branch Manager, **I want to** see what a party owes and their credit **so that** I can talk to them with facts.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/ledger/parties/:partyType/:id` | `finance.invoices.view` | A party's account: credit, what they owe, net | [GetLedgerPartiesPartyTypeId](39_api_response_shapes.md#getledgerpartiespartytypeid) |

### B-FIN-11 · Lock a period

**As an** Accountant or Owner, **I want to** lock the books to a past date, with a reason **so that** closed months stay closed.

*Surface: Web*

**Acceptance criteria**

- `null` unlocks.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/ledger/period-lock` | `finance.ledger.view` | Until when the books are locked | [GetLedgerPeriodLock](39_api_response_shapes.md#getledgerperiodlock) |
| PUT | `/api/v1/ledger/period-lock` | `finance.period.lock` | Lock the books up to a past date (null unlocks); with a reason | [GetLedgerPeriodLock](39_api_response_shapes.md#getledgerperiodlock) |

### B-FIN-12 · Pay suppliers

**As an** Accountant or Owner, **I want to** see aged payables, bills and statements, and pay several bills at once **so that** we pay on time, in one go.

*Surface: Web*

**Acceptance criteria**

- Up to 50 approved bills in one currency, with optional withholding tax.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/payables/aged` | `finance.payables.view` | What the business owes on approved, unpaid bills by payee, aged by days past due (current, 1–30, 31–60, 61–90, over 90) | [GetPayablesAged](39_api_response_shapes.md#getpayablesaged) |
| GET | `/api/v1/suppliers/:id/bills` | `finance.payables.view` | A supplier's open bills with their due dates from its payment terms | [GetSuppliersIdBills](39_api_response_shapes.md#getsuppliersidbills) |
| GET | `/api/v1/suppliers/:id/statement` | `finance.payables.view` | A supplier's statement: what was billed and paid in the period with the running balance owed, and its open bills aged | [GetSuppliersIdStatement](39_api_response_shapes.md#getsuppliersidstatement) |
| POST | `/api/v1/suppliers/:id/payments` | `suppliers.payments.make` | Pay several of a supplier's approved bills in one payment, optionally withholding tax | [PostSuppliersIdPayments](39_api_response_shapes.md#postsuppliersidpayments) |

## Accounting export and reconciliation

### B-ACC-01 · Export to our accounting package

**As an** Accountant or Owner, **I want to** map accounts and export journals for QuickBooks, Xero or CSV **so that** our accountant needs no retyping.

*Surface: Web*

**Acceptance criteria**

- Up to 366 days, in base currency, refused unless balanced.
- History shows entries posted into a period since its export. The `X-Export-Overlaps` header counts earlier exports of the period.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/accounting/export` | `finance.export` | Journals of a period as a file for QuickBooks, Xero or plain CSV | File |
| GET | `/api/v1/accounting/exports` | `finance.export` | Exports taken, with the entries posted into each period since | [GetAccountingExportsItem](39_api_response_shapes.md#getaccountingexportsitem)[] |
| GET | `/api/v1/accounting/mappings` | `finance.export` | Every ledger account with its name or code in the accounting package | [GetAccountingMappingsItem](39_api_response_shapes.md#getaccountingmappingsitem)[] |
| PUT | `/api/v1/accounting/mappings` | `finance.export` | Set account names or codes in the package (external null removes one) | [GetAccountingMappingsItem](39_api_response_shapes.md#getaccountingmappingsitem)[] |

### B-ACC-02 · Import a statement

**As an** Accountant or Owner, **I want to** check and import a bank or MoMo statement CSV **so that** we can compare it with our books.

*Surface: Web*

**Acceptance criteria**

- Up to 5,000 lines, checked first, then committed all or none.
- Voiding takes a statement back unless an entry stands posted from it.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/reconciliation/imports` | `finance.reconcile` | Check (and with commit: import and match) a bank or mobile money statement CSV | [PostReconciliationImports](39_api_response_shapes.md#postreconciliationimports) |
| GET | `/api/v1/reconciliation/imports` | `finance.reconcile` | Statements imported, newest first | [GetReconciliationImportsItem](39_api_response_shapes.md#getreconciliationimportsitem)[] |
| POST | `/api/v1/reconciliation/imports/:id/void` | `finance.reconcile` | Take a statement back with its matches | No body (204) |

### B-ACC-03 · Match statement lines

**As an** Accountant or Owner, **I want to** match automatically and by hand with suggestions **so that** every line is explained.

*Surface: Web*

**Acceptance criteria**

- A manual match must be exactly the line's total.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/reconciliation/lines` | `finance.reconcile` | An account's statement lines; unmatched ones come with likely ledger lines | [StatementLineView](39_api_response_shapes.md#statementlineview)[] |
| GET | `/api/v1/reconciliation/ledger-lines` | `finance.reconcile` | An account's ledger lines of a period not on a statement yet | [LedgerLineView](39_api_response_shapes.md#ledgerlineview)[] |
| POST | `/api/v1/reconciliation/auto-match` | `finance.reconcile` | Match an account's lines again, for payments recorded since | [PostReconciliationAutoMatch](39_api_response_shapes.md#postreconciliationautomatch) |
| POST | `/api/v1/reconciliation/match` | `finance.reconcile` | Match a statement line to ledger lines of the same total | [PostReconciliationMatch](39_api_response_shapes.md#postreconciliationmatch) |
| POST | `/api/v1/reconciliation/lines/:id/unmatch` | `finance.reconcile` | Put a statement line back to unmatched, reversing an entry posted from it | [PostReconciliationMatch](39_api_response_shapes.md#postreconciliationmatch) |

### B-ACC-04 · Clear what is left

**As an** Accountant or Owner, **I want to** post what the books lack, or ignore a line with a note, and see the difference **so that** the account reconciles.

*Surface: Web*

**Acceptance criteria**

- Posting follows the period lock. Unmatching reverses a posted entry.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/reconciliation/lines/:id/post` | `finance.reconcile` | Post what the books lack (bank charges, cash banked) from a statement line | [PostReconciliationMatch](39_api_response_shapes.md#postreconciliationmatch) |
| POST | `/api/v1/reconciliation/lines/:id/ignore` | `finance.reconcile` | Mark a statement line as needing no entry, with a note | [PostReconciliationMatch](39_api_response_shapes.md#postreconciliationmatch) |
| GET | `/api/v1/reconciliation/summary` | `finance.reconcile` | Statement against books for an account at a date, with the difference | [GetReconciliationSummary](39_api_response_shapes.md#getreconciliationsummary) |

---

# Part 7: Buying and selling vehicles

## Vehicle purchases

### B-PUR-01 · Draft a purchase

**As a** Branch Manager or Fleet Officer, **I want to** draft a local, import or auction purchase with one line per vehicle **so that** buying is on record.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/purchases` | `purchases.view` | Vehicle purchases in your branches, newest first | [PurchaseSummary](39_api_response_shapes.md#purchasesummary)[] |
| POST | `/api/v1/purchases` | `purchases.create` | Draft a purchase from a seller with one line per vehicle | [PurchaseView](39_api_response_shapes.md#purchaseview) |
| GET | `/api/v1/purchases/:id` | `purchases.view` | A purchase with its vehicles, costs, landed cost per vehicle and timeline | [PurchaseView](39_api_response_shapes.md#purchaseview) |
| PUT | `/api/v1/purchases/:id` | `purchases.create` | Edit a draft purchase and its vehicles | [PurchaseView](39_api_response_shapes.md#purchaseview) |

### B-PUR-02 · Order or cancel

**As a** Branch Manager, **I want to** order a purchase, or cancel before anything is received **so that** sellers' bills are raised properly.

*Surface: Web*

**Acceptance criteria**

- Ordering turns each vehicle's price into a bill. Cancelling voids unpaid costs.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/purchases/:id/order` | `purchases.approve` | Order the purchase: each vehicle's price becomes a bill to the seller | [PurchaseView](39_api_response_shapes.md#purchaseview) |
| POST | `/api/v1/purchases/:id/cancel` | `purchases.approve` | Cancel a purchase before anything was received (its unpaid costs are voided) | [PurchaseView](39_api_response_shapes.md#purchaseview) |

### B-PUR-03 · Track costs

**As a** Branch Manager or Accountant, **I want to** add and remove costs and see landed cost per vehicle **so that** I know what each car really cost.

*Surface: Web*

**Acceptance criteria**

- A cost is a bill to its payee in its currency, for one vehicle or shared by value or equally.
- A paid cost needs its payment reversed first.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/purchases/:id/costs` | `purchases.costs.manage` | Add a cost component (a bill to its payee in its currency), for one vehicle or shared | [PurchaseView](39_api_response_shapes.md#purchaseview) |
| POST | `/api/v1/purchases/:id/costs/:costId/remove` | `purchases.costs.manage` | Remove a cost component (its bill is voided; a paid one: reverse the payment first) | [PurchaseView](39_api_response_shapes.md#purchaseview) |
| GET | `/api/v1/purchases/:id/landed-cost` | `purchases.view` | The landed cost per vehicle: price, own costs, share of shared costs, pending | [GetPurchasesIdLandedCost](39_api_response_shapes.md#getpurchasesidlandedcost) |

### B-PUR-04 · Follow an import

**As a** Branch Manager or Fleet Officer, **I want to** keep shipping details, stages and notes **so that** I know where every car is.

*Surface: Web*

**Acceptance criteria**

- The timeline only moves forward.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| PATCH | `/api/v1/purchases/:id/shipping` | `purchases.create` | Vessel, bill of lading, container, ETA and free days at the port | [PurchaseView](39_api_response_shapes.md#purchaseview) |
| POST | `/api/v1/purchases/:id/stage` | `purchases.create` | Move an import forward along its timeline (shipped, arrived at the port …) | [PurchaseView](39_api_response_shapes.md#purchaseview) |
| POST | `/api/v1/purchases/:id/notes` | `purchases.create` | Add a note to the purchase's timeline | [PurchaseView](39_api_response_shapes.md#purchaseview) |
| PATCH | `/api/v1/purchases/:id/lines/:lineId` | `purchases.create` | Correct a vehicle's details (VIN, year, colour …) until it is received | [PurchaseView](39_api_response_shapes.md#purchaseview) |

### B-PUR-05 · Receive a vehicle

**As a** Branch Manager or Fleet Officer, **I want to** receive a line into the fleet **so that** it is registered at its landed cost.

*Surface: Web, Mobile*

**Acceptance criteria**

- Needs `vehicles.create` too. Later costs update the vehicle.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/purchases/:id/lines/:lineId/receive` | `purchases.receive` | Receive a vehicle: registers it in the fleet at its landed cost so far | [PurchaseView](39_api_response_shapes.md#purchaseview) |

### B-PUR-06 · Keep the papers

**As a** Branch Manager or Fleet Officer, **I want to** attach invoices, bills of lading, titles and customs papers **so that** they are all in one place.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/purchases/:id/documents` | `purchases.view` | The purchase's papers | [PostDealerAppraisalsIdPhotosFileIdComplete](39_api_response_shapes.md#postdealerappraisalsidphotosfileidcomplete)[] |
| POST | `/api/v1/purchases/:id/documents` | `purchases.create` | Attach a paper (invoice, bill of lading, title, customs declaration …) | [PostDealerAppraisalsIdPhotos](39_api_response_shapes.md#postdealerappraisalsidphotos) |
| POST | `/api/v1/purchases/:id/documents/:fileId/complete` | `purchases.create` | Confirm a paper's upload | [PostDealerAppraisalsIdPhotosFileIdComplete](39_api_response_shapes.md#postdealerappraisalsidphotosfileidcomplete) |
| DELETE | `/api/v1/purchases/:id/documents/:fileId` | `purchases.create` | Remove a paper | No body (204) |

## Dealer stock

### B-STK-01 · See stock

**As a** Sales Executive or Branch Manager, **I want to** list and open stock with ageing **so that** I know what we have and what is getting old.

*Surface: Web, Mobile*

**Acceptance criteria**

- Cost, minimum price and margin appear only with `dealer.stock.cost.view`, so tolerate them being absent.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/dealer/stock` | `dealer.stock.list` | Dealer stock in your branches, oldest stock first | [GetDealerStockItem](39_api_response_shapes.md#getdealerstockitem)[] |
| GET | `/api/v1/dealer/stock/ageing` | `dealer.stock.list` | Stock on the lot valued at asking price and cost: by days in stock (0–30, 31–60, 61–90, over 90), status, source, make and branch | [GetDealerStockAgeing](39_api_response_shapes.md#getdealerstockageing) |
| GET | `/api/v1/dealer/stock/summary` | `dealer.stock.list` | Stock on the lot by make and model (or make, or make, model and year): units, asking value and, with dealer.stock.cost.view, cost, profit and margin | [GetDealerStockSummary](39_api_response_shapes.md#getdealerstocksummary) |
| GET | `/api/v1/dealer/stock/:vehicleId` | `dealer.stock.view` | A stock vehicle (cost, minimum price and margin with dealer.stock.cost.view) | [GetDealerStockItem](39_api_response_shapes.md#getdealerstockitem) |
| GET | `/api/v1/dealer/stock/:vehicleId/transfers` | `dealer.stock.view` | The vehicle's branch transfers while in stock | [GetDealerStockVehicleIdTransfersItem](39_api_response_shapes.md#getdealerstockvehicleidtransfersitem)[] |

### B-STK-02 · Take a car into stock

**As a** Branch Manager or Fleet Officer, **I want to** add a vehicle, or restock it, and keep terms and notes **so that** it can be sold.

*Surface: Web*

**Acceptance criteria**

- Sources: purchase, trade-in, consignment, repossession or other.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/dealer/stock` | `dealer.stock.create` | Take a vehicle into stock (or back into stock after it was withdrawn) | [GetDealerStockItem](39_api_response_shapes.md#getdealerstockitem) |
| PATCH | `/api/v1/dealer/stock/:vehicleId` | `dealer.stock.update` | Holding cost per day, consignment terms and notes | [GetDealerStockItem](39_api_response_shapes.md#getdealerstockitem) |

### B-STK-03 · Move through reconditioning

**As a** Branch Manager or Fleet Officer, **I want to** mark ready or send back **so that** only good cars go on sale.

*Surface: Web, Mobile*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/dealer/stock/:vehicleId/ready` | `dealer.stock.update` | Reconditioning is done: ready to price and list | [GetDealerStockItem](39_api_response_shapes.md#getdealerstockitem) |
| POST | `/api/v1/dealer/stock/:vehicleId/recondition` | `dealer.stock.update` | Back into reconditioning | [GetDealerStockItem](39_api_response_shapes.md#getdealerstockitem) |

### B-STK-04 · Price stock

**As a** Branch Manager, **I want to** set asking and minimum prices and see their history **so that** pricing is deliberate.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| PATCH | `/api/v1/dealer/stock/:vehicleId/pricing` | `dealer.stock.price.manage` | Set the asking and minimum prices (logged in the price history) | [GetDealerStockItem](39_api_response_shapes.md#getdealerstockitem) |
| GET | `/api/v1/dealer/stock/:vehicleId/price-history` | `dealer.stock.view` | Every price change (minimum prices with dealer.stock.cost.view) | [GetDealerStockVehicleIdPriceHistoryItem](39_api_response_shapes.md#getdealerstockvehicleidpricehistoryitem)[] |

### B-STK-05 · List or withdraw

**As a** Branch Manager, **I want to** put a car on sale, take it off, or withdraw it **so that** stock reflects our plans.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/dealer/stock/:vehicleId/list` | `dealer.stock.list_for_sale` | Put the vehicle on sale at its asking price | [GetDealerStockItem](39_api_response_shapes.md#getdealerstockitem) |
| POST | `/api/v1/dealer/stock/:vehicleId/unlist` | `dealer.stock.list_for_sale` | Take the vehicle off sale | [GetDealerStockItem](39_api_response_shapes.md#getdealerstockitem) |
| POST | `/api/v1/dealer/stock/:vehicleId/withdraw` | `dealer.stock.withdraw` | Withdraw the vehicle from stock into another use | [GetDealerStockItem](39_api_response_shapes.md#getdealerstockitem) |

### B-STK-06 · Transfer stock

**As a** Branch Manager or Fleet Officer, **I want to** move a car, or several, between branches **so that** they sit where they will sell.

*Surface: Web*

**Acceptance criteria**

- Needs the permission at both branches.
- Several vehicles go under one reference, all or none: named, or `pick` a number of a make and model (and year) at the sending branch, oldest stock first.
- Reserved vehicles and vehicles no longer on the lot stay; the error names the vehicle by its code.
- Each vehicle's own transfers show the batch it went with (`batchId`).

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/dealer/stock/:vehicleId/transfer` | `dealer.stock.transfer` | Transfer the vehicle to another branch with a transfer record | [GetDealerStockItem](39_api_response_shapes.md#getdealerstockitem) |
| POST | `/api/v1/dealer/stock/transfers` | `dealer.stock.transfer` | Transfer several stock vehicles to another branch under one reference: the vehicles named, or a number of a make and model, oldest stock first | [TransferBatchView](39_api_response_shapes.md#transferbatchview) |
| GET | `/api/v1/dealer/stock/transfers` | `dealer.stock.list` | Transfers of several vehicles leaving or reaching your branches, newest first | [GetDealerStockTransfersItem](39_api_response_shapes.md#getdealerstocktransfersitem)[] |
| GET | `/api/v1/dealer/stock/transfers/:id` | `dealer.stock.view` | A transfer of several vehicles with the vehicles it sent | [TransferBatchView](39_api_response_shapes.md#transferbatchview) |

## Leads, test drives and quotes

### B-LEAD-01 · Capture and find leads

**As a** Sales Executive or Branch Manager, **I want to** add and list leads **so that** no enquiry is lost.

*Surface: Web, Mobile*

**Acceptance criteria**

- Unassigned leads go to the next in rotation, or to whoever entered them.
- `own` scope sees the seller's own.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/dealer/leads` | `dealer.leads.view` | Leads, newest first (own scope: those assigned to you) | [LeadView](39_api_response_shapes.md#leadview)[] |
| POST | `/api/v1/dealer/leads` | `dealer.leads.create` | Capture a lead; unassigned it goes to the next in the branch's rotation, or to you | [LeadDetailView](39_api_response_shapes.md#leaddetailview) |
| GET | `/api/v1/dealer/leads/:id` | `dealer.leads.view` | A lead with its activity log and follow-ups | [LeadDetailView](39_api_response_shapes.md#leaddetailview) |
| PATCH | `/api/v1/dealer/leads/:id` | `dealer.leads.update` | Edit the lead's contact, interest and saved search | [LeadDetailView](39_api_response_shapes.md#leaddetailview) |

### B-LEAD-02 · Work a lead

**As a** Sales Executive or Branch Manager, **I want to** move stages, log activity and set follow-ups **so that** deals progress.

*Surface: Web, Mobile*

**Acceptance criteria**

- Lost needs a reason. Logging contact moves a new lead to contacted.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/dealer/leads/:id/stage` | `dealer.leads.update` | Move the lead along the pipeline (lost needs a reason) | [LeadDetailView](39_api_response_shapes.md#leaddetailview) |
| POST | `/api/v1/dealer/leads/:id/activities` | `dealer.leads.update` | Log a call, message, visit or note (contact moves a new lead to contacted) | [LeadDetailView](39_api_response_shapes.md#leaddetailview) |
| POST | `/api/v1/dealer/leads/:id/tasks` | `dealer.leads.update` | Add a follow-up, reminded on the day it is due | [LeadDetailView](39_api_response_shapes.md#leaddetailview) |
| POST | `/api/v1/dealer/leads/:id/tasks/:taskId/done` | `dealer.leads.update` | Mark a follow-up done | [LeadDetailView](39_api_response_shapes.md#leaddetailview) |

### B-LEAD-03 · Match stock to a lead

**As a** Sales Executive or Branch Manager, **I want to** see listed stock fitting a lead's saved search **so that** I can offer the right car.

*Surface: Web, Mobile*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/dealer/leads/:id/matches` | `dealer.leads.view` | Listed stock that fits the lead's saved search | [GetDealerLeadsIdMatchesItem](39_api_response_shapes.md#getdealerleadsidmatchesitem)[] |

### B-LEAD-04 · Share out leads

**As a** Branch Manager, **I want to** assign leads and set the rotation **so that** everyone gets a fair share.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/dealer/leads/:id/assign` | `dealer.leads.assign` | Give the lead to someone, to the next in turn, or to nobody (null) | [LeadDetailView](39_api_response_shapes.md#leaddetailview) |
| GET | `/api/v1/dealer/lead-rotation/:branchId` | `dealer.leads.assign` | Who takes the branch's new leads in turn | string[] |
| PUT | `/api/v1/dealer/lead-rotation/:branchId` | `dealer.leads.assign` | Set who takes the branch's new leads in turn (in this order) | string[] |

### B-LEAD-05 · See the funnel

**As a** Sales Executive or Branch Manager, **I want to** see leads by stage, source and seller with conversion **so that** I know what works.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/dealer/leads/funnel` | `dealer.leads.view` | Leads created in a period by stage, source and sales executive, with conversion | [GetDealerLeadsFunnel](39_api_response_shapes.md#getdealerleadsfunnel) |

### B-LEAD-06 · Run test drives

**As a** Sales Executive or Branch Manager, **I want to** book, start, return and cancel drives **so that** cars and customers are protected.

*Surface: Web, Mobile*

**Acceptance criteria**

- Booking blocks the vehicle. Licence is checked at booking and departure; a waiver issues when the car goes out.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/dealer/test-drives` | `dealer.testdrives.manage` | Test drives in your branches, newest first | [TestDriveProps](39_api_response_shapes.md#testdriveprops)[] |
| POST | `/api/v1/dealer/test-drives` | `dealer.testdrives.manage` | Book a test drive on a ready or listed stock vehicle (blocks the vehicle) | [TestDriveProps](39_api_response_shapes.md#testdriveprops) |
| GET | `/api/v1/dealer/test-drives/:id` | `dealer.testdrives.manage` | A test drive | [TestDriveProps](39_api_response_shapes.md#testdriveprops) |
| POST | `/api/v1/dealer/test-drives/:id/start` | `dealer.testdrives.manage` | The car goes out: the odometer read and the waiver issued for signature | [TestDriveProps](39_api_response_shapes.md#testdriveprops) |
| POST | `/api/v1/dealer/test-drives/:id/return` | `dealer.testdrives.manage` | The car is back: the odometer and the driver's feedback | [TestDriveProps](39_api_response_shapes.md#testdriveprops) |
| POST | `/api/v1/dealer/test-drives/:id/cancel` | `dealer.testdrives.manage` | Cancel a booked drive, or record that the driver did not come | [TestDriveProps](39_api_response_shapes.md#testdriveprops) |

### B-LEAD-07 · Quote a price

**As a** Sales Executive or Branch Manager, **I want to** draft, send and record the answer to a quote **so that** the customer has clear terms.

*Surface: Web, Mobile*

**Acceptance criteria**

- Valid 14 days by default. Sending issues a PDF and moves the lead to negotiation.
- Approving below minimum also needs `dealer.stock.price.manage`.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/dealer/quotes` | `dealer.quotes.manage` | Sales quotes in your branches, newest first | [QuoteView](39_api_response_shapes.md#quoteview)[] |
| POST | `/api/v1/dealer/quotes` | `dealer.quotes.manage` | Draft a quote for a stock vehicle (at its asking price unless another is given) | [QuoteView](39_api_response_shapes.md#quoteview) |
| GET | `/api/v1/dealer/quotes/:id` | `dealer.quotes.manage` | A quote with its totals (its PDF is the document it was sent as) | [QuoteView](39_api_response_shapes.md#quoteview) |
| PUT | `/api/v1/dealer/quotes/:id` | `dealer.quotes.manage` | Edit a draft quote | [QuoteView](39_api_response_shapes.md#quoteview) |
| POST | `/api/v1/dealer/quotes/:id/approve` | `dealer.quotes.manage` | Approve a price below the minimum (dealer.stock.price.manage) | [QuoteView](39_api_response_shapes.md#quoteview) |
| POST | `/api/v1/dealer/quotes/:id/send` | `dealer.quotes.manage` | Issue the quotation PDF and log it on the lead | [QuoteView](39_api_response_shapes.md#quoteview) |
| POST | `/api/v1/dealer/quotes/:id/decision` | `dealer.quotes.manage` | Record the customer's acceptance or rejection, or withdraw the quote | [QuoteView](39_api_response_shapes.md#quoteview) |

## Trade-ins, deals and commissions

### B-DEAL-01 · Appraise a trade-in

**As a** Sales Executive or Branch Manager, **I want to** record a value with photos, revise it, or record a decline **so that** part exchange is fair.

*Surface: Web, Mobile*

**Acceptance criteria**

- Valid 14 days unless a date is given.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/dealer/appraisals` | `dealer.appraisals.manage` | Trade-in appraisals in your branches, newest first | [AppraisalView](39_api_response_shapes.md#appraisalview)[] |
| POST | `/api/v1/dealer/appraisals` | `dealer.appraisals.manage` | Appraise a vehicle offered in part exchange (valid 14 days unless a date is given) | [AppraisalView](39_api_response_shapes.md#appraisalview) |
| GET | `/api/v1/dealer/appraisals/:id` | `dealer.appraisals.manage` | An appraisal with its photos | [AppraisalView](39_api_response_shapes.md#appraisalview) |
| PUT | `/api/v1/dealer/appraisals/:id` | `dealer.appraisals.manage` | Revise an open appraisal | [AppraisalView](39_api_response_shapes.md#appraisalview) |
| POST | `/api/v1/dealer/appraisals/:id/decline` | `dealer.appraisals.manage` | The customer declined the offer for their vehicle | [AppraisalView](39_api_response_shapes.md#appraisalview) |
| POST | `/api/v1/dealer/appraisals/:id/photos` | `dealer.appraisals.manage` | Attach a photo to an appraisal | [PostDealerAppraisalsIdPhotos](39_api_response_shapes.md#postdealerappraisalsidphotos) |
| POST | `/api/v1/dealer/appraisals/:id/photos/:fileId/complete` | `dealer.appraisals.manage` | Confirm an appraisal photo upload | [PostDealerAppraisalsIdPhotosFileIdComplete](39_api_response_shapes.md#postdealerappraisalsidphotosfileidcomplete) |

### B-DEAL-02 · Open a deal

**As a** Sales Executive or Branch Manager, **I want to** open and revise a deal from a quote or afresh **so that** the sale is under way.

*Surface: Web, Mobile*

**Acceptance criteria**

- One open deal per vehicle, for a registered customer.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/dealer/deals` | `dealer.deals.view` | Deals you can see, newest first | [DealView](39_api_response_shapes.md#dealview)[] |
| POST | `/api/v1/dealer/deals` | `dealer.deals.create` | Open a deal on a stock vehicle, from a quote or afresh | [DealView](39_api_response_shapes.md#dealview) |
| GET | `/api/v1/dealer/deals/:id` | `dealer.deals.view` | A deal with its payments, instalments and photos | [DealView](39_api_response_shapes.md#dealview) |
| PUT | `/api/v1/dealer/deals/:id` | `dealer.deals.create` | Revise a deal before the sale (fields left out stay as they are) | [DealView](39_api_response_shapes.md#dealview) |

### B-DEAL-03 · Approve a price

**As a** Branch Manager, **I want to** approve below-minimum prices and large discounts **so that** margin stays protected.

*Surface: Web, Mobile*

**Acceptance criteria**

- Sellers may discount up to their limit, 5% by default.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/dealer/deals/:id/approve` | `dealer.deals.approve` | Approve a price below the minimum or a discount over the seller's limit | [DealView](39_api_response_shapes.md#dealview) |

### B-DEAL-04 · Take money on a deal

**As a** Cashier or Branch Manager, **I want to** record deposits and payments **so that** the customer is credited.

*Surface: Web*

**Acceptance criteria**

- Held as credit, then applied at the sale.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/dealer/deals/:id/payments` | `dealer.deals.payments.record` | Record a deposit or other payment for the deal | [DealView](39_api_response_shapes.md#dealview) |

### B-DEAL-05 · Follow a bank loan

**As a** Sales Executive or Branch Manager, **I want to** record the bank's answer **so that** the money arrives on record.

*Surface: Web*

**Acceptance criteria**

- Disbursed records the bank's payment.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/dealer/deals/:id/loan` | `dealer.deals.view` | The bank's answer on the loan; disbursed records the bank's payment | [DealView](39_api_response_shapes.md#dealview) |

### B-DEAL-06 · Reserve a car

**As a** Sales Executive or Branch Manager, **I want to** hold a car against a deposit **so that** the customer's choice is safe.

*Surface: Web, Mobile*

**Acceptance criteria**

- A week unless given, up to 30 days; it lapses back to sale.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/dealer/deals/:id/reserve` | `dealer.deals.create` | Hold the vehicle against the deposit until a date (a week unless given) | [DealView](39_api_response_shapes.md#dealview) |

### B-DEAL-07 · Sell

**As a** Sales Executive or Branch Manager, **I want to** complete the sale **so that** the invoice, trade-in, schedule and agreement all follow.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/dealer/deals/:id/sell` | `dealer.deals.create` | Sell: the invoice, the trade-in into stock, the schedule and the agreement | [DealView](39_api_response_shapes.md#dealview) |

### B-DEAL-08 · Deliver

**As a** Sales Executive or Branch Manager, **I want to** hand over against a checklist with photos **so that** delivery is on record.

*Surface: Web, Mobile*

**Acceptance criteria**

- Allowed once paid, or once the trade-in and down payment are in on in-house terms.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/dealer/deals/:id/deliver` | `dealer.deals.deliver` | Hand the vehicle over against the checklist, with the delivery note | [DealView](39_api_response_shapes.md#dealview) |
| POST | `/api/v1/dealer/deals/:id/photos` | `dealer.deals.view` | Attach a photo to a deal (the handover) | [PostDealerAppraisalsIdPhotos](39_api_response_shapes.md#postdealerappraisalsidphotos) |
| POST | `/api/v1/dealer/deals/:id/photos/:fileId/complete` | `dealer.deals.view` | Confirm a deal photo upload | [PostDealerAppraisalsIdPhotosFileIdComplete](39_api_response_shapes.md#postdealerappraisalsidphotosfileidcomplete) |

### B-DEAL-09 · Call off a deal

**As a** Sales Executive or Branch Manager, **I want to** cancel before the sale **so that** the car goes back on sale.

*Surface: Web*

**Acceptance criteria**

- Payments stay as the customer's credit.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/dealer/deals/:id/cancel` | `dealer.deals.create` | Call off a deal before the sale; payments stay as the customer's credit | [DealView](39_api_response_shapes.md#dealview) |

### B-DEAL-10 · See my commission

**As a** Sales Executive, Branch Manager or Accountant, **I want to** see the statement for a month **so that** I know what I have earned.

*Surface: Web, Mobile*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/dealer/commissions` | `dealer.commissions.view` | The commission statement for a month (own: yours) | [GetDealerCommissions](39_api_response_shapes.md#getdealercommissions) |

### B-DEAL-11 · Manage commission

**As an** Accountant or Owner, **I want to** set plans, split deals, pay out and claw back **so that** sellers are paid correctly.

*Surface: Web*

**Acceptance criteria**

- Splits are whole percentages adding up to 100.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/dealer/commission-plans` | `dealer.commissions.manage` | Commission plans, current first | [PlanView](39_api_response_shapes.md#planview)[] |
| POST | `/api/v1/dealer/commission-plans` | `dealer.commissions.manage` | Set a seller's commission plan, or the plan for everyone (userId null) | [PlanView](39_api_response_shapes.md#planview) |
| PUT | `/api/v1/dealer/commission-plans/:id` | `dealer.commissions.manage` | Revise a plan (from the next delivery) | [PlanView](39_api_response_shapes.md#planview) |
| POST | `/api/v1/dealer/commission-plans/:id/retire` | `dealer.commissions.manage` | Retire a plan | [PlanView](39_api_response_shapes.md#planview) |
| PUT | `/api/v1/dealer/deals/:id/commission-split` | `dealer.commissions.manage` | Share a sale's commission between sellers (whole percentages adding up to 100) | [DealView](39_api_response_shapes.md#dealview) |
| POST | `/api/v1/dealer/commissions/payouts` | `dealer.commissions.manage` | Pay a seller what is payable up to a month, less clawbacks | [PayoutView](39_api_response_shapes.md#payoutview) |
| POST | `/api/v1/dealer/commissions/:id/clawback` | `dealer.commissions.manage` | Claw a commission back (recovered from the next payout once paid) | [CommissionView](39_api_response_shapes.md#commissionview) |

### B-DEAL-12 · See profit and sales performance

**As an** Owner, Branch Manager or Accountant, **I want to** see gross profit, sales, price cuts and collections **so that** I know what the lot earns.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/dealer/gross-profit` | `dealer.stock.cost.view` | Gross profit per unit sold in a period | [GetDealerGrossProfit](39_api_response_shapes.md#getdealergrossprofit) |
| GET | `/api/v1/dashboards/dealer` | `dashboards.dealer.view` | Units sold and delivered with revenue and days to sell, stock on hand, leads won and lost, cash collected, owed and held | [GetDashboardsDealer](39_api_response_shapes.md#getdashboardsdealer) |
| GET | `/api/v1/dashboards/dealer/price-reductions` | `dashboards.dealer.view` | Cuts in asking prices in the period, by make and vehicle | [GetDashboardsDealerPriceReductions](39_api_response_shapes.md#getdashboardsdealerpricereductions) |
| GET | `/api/v1/dashboards/dealer/collections` | `dashboards.dealer.view` | Cash collected on sales in the period by method and branch, what sold deals still owe and the deposits held | [GetDashboardsDealerCollections](39_api_response_shapes.md#getdashboardsdealercollections) |

---

# Part 8: Seeing the whole business

## Dashboards

### B-DASH-01 · See the business

**As an** Owner, Branch Manager or Accountant, **I want to** see revenue, costs, net and cash against the last period **so that** I know how we are doing.

*Surface: Web, Mobile*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/dashboards/overview` | `dashboards.overview.view` | Revenue by source, costs, net and cash collected, vs the previous period | [GetDashboardsOverview](39_api_response_shapes.md#getdashboardsoverview) |

### B-DASH-02 · See what each car earns

**As an** Owner, Branch Manager or Accountant, **I want to** see vehicle P&L, cost per km and utilisation **so that** I keep the winners.

*Surface: Web, Mobile*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/dashboards/vehicles` | `dashboards.vehicles.view` | Vehicle P&L: income, costs, depreciation, profit, cost per km and utilisation | [GetDashboardsVehicles](39_api_response_shapes.md#getdashboardsvehicles) |
| GET | `/api/v1/vehicles/:id/profit` | `dashboards.vehicles.view` | A vehicle's P&L for a period with its trend | [GetVehiclesIdProfit](39_api_response_shapes.md#getvehiclesidprofit) |

### B-DASH-03 · See remittances and expenses

**As an** Owner, Branch Manager or Accountant, **I want to** see collection rates, shortfalls, spending and budgets **so that** leaks show quickly.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/dashboards/remittances` | `dashboards.remittances.view` | Remittances expected vs received (by period end), collection rate, drivers short | [GetDashboardsRemittances](39_api_response_shapes.md#getdashboardsremittances) |
| GET | `/api/v1/dashboards/expenses` | `dashboards.expenses.view` | Approved spending by category and vehicle, pending approvals and budgets | [GetDashboardsExpenses](39_api_response_shapes.md#getdashboardsexpenses) |

### B-DASH-04 · Open my role's dashboard

**As a** signed-in user, **I want to** see widgets I may see, read now **so that** my first screen is useful.

*Surface: Web, Mobile*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/dashboards/roles` | Signed-in | The role dashboards with their widgets, and every widget a dashboard can show | [GetDashboardsRoles](39_api_response_shapes.md#getdashboardsroles) |
| GET | `/api/v1/dashboards/roles/:role` | Signed-in | A role's dashboard: the widgets you may see, read now | [GetDashboardsRolesRole](39_api_response_shapes.md#getdashboardsrolesrole) |

### B-DASH-05 · Choose dashboard widgets

**As an** Owner or Administrator, **I want to** choose and reorder a role's widgets, or reset them **so that** each role sees what matters here.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| PUT | `/api/v1/dashboards/roles/:role/layout` | `settings.update` | Choose the widgets of a role's dashboard, in order | [PutDashboardsRolesRoleLayout](39_api_response_shapes.md#putdashboardsrolesrolelayout) |
| DELETE | `/api/v1/dashboards/roles/:role/layout` | `settings.update` | Go back to the default widgets of a role's dashboard | [PutDashboardsRolesRoleLayout](39_api_response_shapes.md#putdashboardsrolesrolelayout) |

### B-DASH-06 · Refresh vehicle statistics

**As an** Accountant or Owner, **I want to** bring the statistics up to date now **so that** I do not have to wait for the night run.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/dashboards/stats/rebuild` | `dashboards.stats.rebuild` | Bring the vehicle statistics up to date now | [PostDashboardsStatsRebuild](39_api_response_shapes.md#postdashboardsstatsrebuild) |

## Reports

### B-RPT-01 · Run a report

**As a** signed-in user, **I want to** pick a report I may run, fill its parameters and see it **so that** I can answer any question.

*Surface: Web*

**Acceptance criteria**

- The catalogue is filtered by permission and describes each parameter, so build the form from it.
- JSON answers at once up to 2,000 rows.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/reports` | Signed-in | The reports you may run, with their parameters and formats | [GetReportsItem](39_api_response_shapes.md#getreportsitem)[] |
| POST | `/api/v1/reports/:reportId/run` | Signed-in | Run a report: JSON is answered at once; CSV, XLSX and PDF are built in the background (202 with the job) | [PostReportsReportIdRun](39_api_response_shapes.md#postreportsreportidrun) / [PostReportsReportIdRun2](39_api_response_shapes.md#postreportsreportidrun2) |

### B-RPT-02 · Download a report file

**As a** signed-in user, **I want to** get CSV, XLSX or PDF and download when ready **so that** I can share it.

*Surface: Web*

**Acceptance criteria**

- Files build in the background (202 with the job); poll the job. Files last 7 days.
- `429 REPORT_BUSY` means too many at once (4 per business, 2 per user).

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/reports/:reportId/run` | Signed-in | Run a report: JSON is answered at once; CSV, XLSX and PDF are built in the background (202 with the job) | [PostReportsReportIdRun](39_api_response_shapes.md#postreportsreportidrun) / [PostReportsReportIdRun2](39_api_response_shapes.md#postreportsreportidrun2) |
| GET | `/api/v1/reports/jobs` | Signed-in | Your report files, newest first | [PostReportsReportIdRun2](39_api_response_shapes.md#postreportsreportidrun2)[] |
| GET | `/api/v1/reports/jobs/:id` | Signed-in | One of your report files: its status and, once ready, a short-lived download link | [PostReportsReportIdRun2](39_api_response_shapes.md#postreportsreportidrun2) |

### B-RPT-03 · Schedule a report

**As an** Owner, Accountant or Branch Manager, **I want to** send a report daily, weekly or monthly to up to 20 users **so that** people get it without asking.

*Surface: Web*

**Acceptance criteria**

- A schedule runs as its owner and pauses if the owner can no longer run it.
- At most 100 schedules per business. `own` scope manages only the user's own.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/reports/schedules` | `reports.schedules.manage` | Report schedules: yours, or all with the all scope | [GetReportsSchedulesItem](39_api_response_shapes.md#getreportsschedulesitem)[] |
| POST | `/api/v1/reports/schedules` | `reports.schedules.manage` | Send a report on a schedule: built daily, weekly or monthly at a local hour as you, to up to 20 users who may run it | [GetReportsSchedulesItem](39_api_response_shapes.md#getreportsschedulesitem) |
| GET | `/api/v1/reports/schedules/:id` | `reports.schedules.manage` | One report schedule | [GetReportsSchedulesItem](39_api_response_shapes.md#getreportsschedulesitem) |
| PUT | `/api/v1/reports/schedules/:id` | `reports.schedules.manage` | Change a report schedule (it still runs as its owner) | [GetReportsSchedulesItem](39_api_response_shapes.md#getreportsschedulesitem) |
| POST | `/api/v1/reports/schedules/:id/pause` | `reports.schedules.manage` | Pause a report schedule | [GetReportsSchedulesItem](39_api_response_shapes.md#getreportsschedulesitem) |
| POST | `/api/v1/reports/schedules/:id/resume` | `reports.schedules.manage` | Resume a paused report schedule from its next run day | [GetReportsSchedulesItem](39_api_response_shapes.md#getreportsschedulesitem) |
| POST | `/api/v1/reports/schedules/:id/run` | `reports.schedules.manage` | Build and send a scheduled report now (the next run stays) | [GetReportsSchedulesItem](39_api_response_shapes.md#getreportsschedulesitem) |
| DELETE | `/api/v1/reports/schedules/:id` | `reports.schedules.manage` | Remove a report schedule (runs already sent stay until they expire) | No body (204) |

---

# Part 9: Integrations and our subscription

## API keys and webhooks

These need an Enterprise licence (`403 ENTERPRISE_LICENCE_REQUIRED`).

### B-INT-01 · Manage API keys

**As an** Owner or Administrator, **I want to** create and revoke keys limited to scopes **so that** our systems can connect safely.

*Surface: Web*

**Acceptance criteria**

- The key is shown once. It acts as its maker within its scopes.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/integrations/api-key-scopes` | `integrations.view` | What an API key can be given | [GetIntegrationsApiKeyScopesItem](39_api_response_shapes.md#getintegrationsapikeyscopesitem)[] |
| GET | `/api/v1/integrations/api-keys` | `integrations.view` | The business's API keys with their last use and requests counted | [GetIntegrationsApiKeysItem](39_api_response_shapes.md#getintegrationsapikeysitem)[] |
| POST | `/api/v1/integrations/api-keys` | `integrations.manage` | Creates an API key acting as you within its scopes; it is shown this once | [PostIntegrationsApiKeys](39_api_response_shapes.md#postintegrationsapikeys) |
| DELETE | `/api/v1/integrations/api-keys/:id` | `integrations.manage` | Revokes an API key at once | No body (204) |

### B-INT-02 · Manage webhooks

**As an** Owner or Administrator, **I want to** add https addresses, choose events, rotate secrets and test **so that** our systems hear what happens.

*Surface: Web*

**Acceptance criteria**

- The secret is shown once. Private addresses are refused.
- An address failing for days is switched off, so show its state.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/integrations/webhook-events` | `integrations.view` | The events a webhook can subscribe to | [GetIntegrationsWebhookEventsItem](39_api_response_shapes.md#getintegrationswebhookeventsitem)[] |
| GET | `/api/v1/integrations/webhooks` | `integrations.view` | The business's webhook addresses | [GetIntegrationsWebhooksItem](39_api_response_shapes.md#getintegrationswebhooksitem)[] |
| POST | `/api/v1/integrations/webhooks` | `integrations.manage` | Adds an https address; the signing secret is shown this once | [PostIntegrationsWebhooks](39_api_response_shapes.md#postintegrationswebhooks) |

### B-INT-03 · Change a webhook

**As an** Owner or Administrator, **I want to** edit, switch off, remove, rotate or test an address **so that** it keeps working.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| PATCH | `/api/v1/integrations/webhooks/:id` | `integrations.manage` | Edits an address, its events, or switches it off and on | [GetIntegrationsWebhooksItem](39_api_response_shapes.md#getintegrationswebhooksitem) |
| DELETE | `/api/v1/integrations/webhooks/:id` | `integrations.manage` | Removes an address and its deliveries | No body (204) |
| POST | `/api/v1/integrations/webhooks/:id/rotate-secret` | `integrations.manage` | Replaces the signing secret; the new one is shown this once | [PostIntegrationsWebhooksIdRotateSecret](39_api_response_shapes.md#postintegrationswebhooksidrotatesecret) |
| POST | `/api/v1/integrations/webhooks/:id/test` | `integrations.manage` | Sends a harmless webhook.test event to the address | [PostIntegrationsWebhooksIdTest](39_api_response_shapes.md#postintegrationswebhooksidtest) |

### B-INT-04 · Debug deliveries

**As an** Owner or Administrator, **I want to** see what was sent and replay it **so that** lost events are recovered.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/integrations/webhooks/:id/deliveries` | `integrations.view` | What was sent to an address and how it answered, newest first | [GetIntegrationsWebhooksIdDeliveriesItem](39_api_response_shapes.md#getintegrationswebhooksiddeliveriesitem)[] |
| POST | `/api/v1/integrations/webhook-deliveries/:id/replay` | `integrations.manage` | Sends a finished delivery again, the same event with the same id | No body (202) |

## Our Autoforce subscription

A business deactivated for non-payment can still sign in and use billing only. Other routes return `403 TENANT_DEACTIVATED`, so send billing users straight to the billing tab.

### B-BIL-01 · See billing warnings

**As a** signed-in user, **I want to** see a banner when payment is due soon **so that** the business is not cut off by surprise.

*Surface: Web, Mobile*

**Acceptance criteria**

- `null` means nothing is due soon.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/billing/banner` | Signed-in | The billing banner for every admin (null when nothing is due soon) | object / null |
| GET | `/api/v1/billing/notices` | `billing.view` | Billing notices sent to your business (newest first) | [GetBillingNoticesItem](39_api_response_shapes.md#getbillingnoticesitem)[] |

### B-BIL-02 · See my subscription

**As an** Owner or Accountant, **I want to** see plan, licence, branches, period and entitlements **so that** I know what I pay for.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/billing/subscription` | `billing.view` | Your plan, licence, billed branches, period and entitlements | [GetBillingSubscription](39_api_response_shapes.md#getbillingsubscription) |
| GET | `/api/v1/billing/upcoming` | `billing.view` | Your next invoice as it stands today: branches, prorations, VAT | [GetBillingUpcoming](39_api_response_shapes.md#getbillingupcoming) |

### B-BIL-03 · See invoices and history

**As an** Owner or Accountant, **I want to** see invoices, receipts and history, and download PDFs **so that** I can keep records.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/billing/invoices` | `billing.view` | Your invoices (newest first) | [TenantInvoiceView](39_api_response_shapes.md#tenantinvoiceview)[] |
| GET | `/api/v1/billing/invoices/:id` | `billing.view` | One of your invoices with its payments | [TenantInvoiceView](39_api_response_shapes.md#tenantinvoiceview) |
| GET | `/api/v1/billing/invoices/:id/pdf` | `billing.view` | One of your invoices as a PDF | File |
| GET | `/api/v1/billing/transactions` | `billing.view` | Your billing history: invoices, cancellations and payments with the balance | [GetBillingTransactions](39_api_response_shapes.md#getbillingtransactions) |
| GET | `/api/v1/billing/receipts` | `billing.view` | Receipts of your payments (newest first) | [TenantPaymentView](39_api_response_shapes.md#tenantpaymentview)[] |
| GET | `/api/v1/billing/receipts/:id` | `billing.view` | One receipt | [TenantPaymentView](39_api_response_shapes.md#tenantpaymentview) |
| GET | `/api/v1/billing/receipts/:id/pdf` | `billing.view` | A receipt as a PDF | File |

### B-BIL-04 · Pay an invoice

**As an** Owner, **I want to** pay by hosted page, saved card or MoMo **so that** service continues.

*Surface: Web, Mobile*

**Acceptance criteria**

- MoMo may prompt the phone or ask for a code.
- Follow the payment by reference; only the server decides it is paid.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/billing/invoices/:id/checkout` | `billing.manage` | Pay an invoice on the provider's hosted page (card, MoMo, bank transfer) | [PostBillingInvoicesIdCheckout](39_api_response_shapes.md#postbillinginvoicesidcheckout) |
| POST | `/api/v1/billing/invoices/:id/pay` | `billing.manage` | Pay an invoice with a saved card or MoMo number | [PostBillingInvoicesIdCheckout](39_api_response_shapes.md#postbillinginvoicesidcheckout) |
| POST | `/api/v1/billing/invoices/:id/momo` | `billing.manage` | Pay an invoice by mobile money: a prompt on the phone (or a code to enter) | [PostBillingInvoicesIdCheckout](39_api_response_shapes.md#postbillinginvoicesidcheckout) |
| GET | `/api/v1/billing/invoices/:id/payment-attempts` | `billing.view` | Payments started on an invoice through the gateway | [PostBillingInvoicesIdCheckout](39_api_response_shapes.md#postbillinginvoicesidcheckout)[] |
| GET | `/api/v1/billing/payments/:reference` | `billing.view` | Where a payment stands (the return page asks the provider while it is pending) | [PostBillingInvoicesIdCheckout](39_api_response_shapes.md#postbillinginvoicesidcheckout) |
| POST | `/api/v1/billing/payments/:reference/otp` | `billing.manage` | Enter the code or voucher the mobile network sent | [PostBillingInvoicesIdCheckout](39_api_response_shapes.md#postbillinginvoicesidcheckout) |

### B-BIL-05 · Manage payment methods

**As an** Owner, **I want to** choose a default or forget a saved method **so that** the right one is charged.

*Surface: Web*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/billing/payment-methods` | `billing.view` | Saved cards and MoMo numbers (default first) | [PaymentMethodView](39_api_response_shapes.md#paymentmethodview)[] |
| POST | `/api/v1/billing/payment-methods/:id/default` | `billing.manage` | Make a saved payment method the default | [PaymentMethodView](39_api_response_shapes.md#paymentmethodview)[] |
| DELETE | `/api/v1/billing/payment-methods/:id` | `billing.manage` | Forget a saved payment method | No body (204) |

### B-BIL-06 · Keep billing details

**As an** Owner, **I want to** change invoice details and contacts **so that** invoices are correct.

*Surface: Web*

**Acceptance criteria**

- Changes apply from the next invoice. 1 to 5 contacts, one primary.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/billing/details` | `billing.view` | Your billing details (as printed on invoices) and billing contacts | [GetBillingDetails](39_api_response_shapes.md#getbillingdetails) |
| PUT | `/api/v1/billing/details` | `billing.manage` | Change your legal name, TIN and address on invoices (from the next invoice) | [PutBillingDetails](39_api_response_shapes.md#putbillingdetails) |
| PUT | `/api/v1/billing/contacts` | `billing.manage` | Who receives invoices, receipts and billing notices (1–5, one primary) | [PutBillingContactsItem](39_api_response_shapes.md#putbillingcontactsitem)[] |

### B-BIL-07 · Ask for more time

**As an** Owner, **I want to** request an extension **so that** I can pay without being cut off.

*Surface: Web*

**Acceptance criteria**

- At most 10 days after the due date.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/billing/extensions` | `billing.view` | Your extension requests and their decisions | [GetBillingExtensionsItem](39_api_response_shapes.md#getbillingextensionsitem)[] |
| POST | `/api/v1/billing/extensions` | `billing.manage` | Ask for more time to pay an invoice (at most 10 days after its due date) | [GetBillingExtensionsItem](39_api_response_shapes.md#getbillingextensionsitem) |

### B-BIL-08 · Accept an Enterprise quote

**As an** Owner, **I want to** read and accept a quote and see my price list **so that** pricing fits my business.

*Surface: Web*

**Acceptance criteria**

- An accepted quote applies from the next invoice.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/billing/quotes` | `billing.view` | Enterprise quotes sent to you (newest first) | [QuoteView2](39_api_response_shapes.md#quoteview2)[] |
| GET | `/api/v1/billing/quotes/:id` | `billing.view` | One of your quotes | [QuoteView2](39_api_response_shapes.md#quoteview2) |
| GET | `/api/v1/billing/quotes/:id/pdf` | `billing.view` | One of your quotes as a PDF | File |
| POST | `/api/v1/billing/quotes/:id/accept` | `billing.manage` | Accept a quote: it becomes your price list from the next invoice | [QuoteView2](39_api_response_shapes.md#quoteview2) |
| GET | `/api/v1/billing/price-items` | `billing.view` | Your Enterprise price list (from the accepted quote) | [PriceItem](39_api_response_shapes.md#priceitem)[] |

### B-BIL-09 · Test payment in development

**As a** developer, **I want to** complete a fake gateway payment **so that** the flow can be tested without a real provider.

*Surface: Web*

**Acceptance criteria**

- Development only. It must never appear in production screens.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/billing/fake-gateway/:reference/complete` | `billing.manage` | Development only: pay a fake-gateway payment as the payer would | No body (204) |

### B-BIL-10 · Receive gateway events (system)

**As a** payment provider, **I want to** tell Autoforce about payments **so that** invoices are settled.

*Surface: None (server to server)*

**Acceptance criteria**

- Signed, and verified with the provider before anything is credited. No screen is needed.

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| POST | `/api/v1/webhooks/billing` | Public | Payment provider webhook (signed; verified with the provider before anything is credited) | No body (200) |

## Technical endpoints

No screen uses these directly, but they are useful to developers and deployment.

### B-SYS-01 · Read the API contract

**As a** developer, **I want to** download the OpenAPI document and check health **so that** I can generate a client and tell if the API is up.

*Surface: Web, Mobile*

| Method | Path | Access | Does | Returns |
|---|---|---|---|---|
| GET | `/api/v1/openapi.json` | Public | OpenAPI document | See OpenAPI |
| GET | `/health/live` | Public | Liveness probe | See OpenAPI |
| GET | `/health/ready` | Public | Readiness probe | See OpenAPI |
| GET | `/api/v1/public/domains/allowed` | Public | For the proxy's on-demand certificates: 200 for a live custom domain, else 404 | No body (200) |

---

# Appendix A: Roles

System roles are seeded into every business and cannot be edited, only cloned.

| Role | Purpose | Permissions |
|---|---|---|
| Owner | Full control, including billing; at least one owner always exists | 191 |
| Administrator | Everything except billing changes, accepting terms and exporting everything | 188 |
| Branch Manager | Runs one or more branches: their people and settings | 130 |
| Rental Agent | Books rentals for customers in their branches, hands vehicles over and takes them back, and registers the customers | 20 |
| Fleet Officer | Vehicles, their documents, odometer and status in their branches | 53 |
| Sales Executive | Sells vehicles in their branches: works the leads given to them, books test drives, sends quotes and makes and delivers the sales | 21 |
| Cashier | Records payments and runs a cash till in their branches | 20 |
| Accountant | Billing, tax and currency settings, reports | 83 |
| Driver | The driver app: their vehicle, ledger and remittances, fuel and issue reports (given from the driver's page) | 1 |
| Auditor (read-only) | Views everything and the audit log; changes nothing | 62 |

# Appendix B: Permissions by role

Abbreviations: Own, Adm(inistrator), Br(anch Manager), Rnt (Rental Agent), Flt (Fleet Officer), Sal(es Executive), Csh (Cashier), Acc(ountant), Drv (Driver), Aud(itor). The letter after a role is its scope when narrower than all: `b` branch, `o` own. **S** marks a sensitive permission.

| Permission | What it allows | Scopes | S | Held by |
|---|---|---|---|---|
| `users.list` | List users | branch, all |  | Own, Adm, Br b, Aud |
| `users.view` | View a user | branch, all |  | Own, Adm, Br b, Aud |
| `users.invite` | Invite users | branch, all |  | Own, Adm, Br b |
| `users.update` | Edit users | branch, all |  | Own, Adm, Br b |
| `users.disable` | Disable or re-enable users | branch, all |  | Own, Adm, Br b |
| `users.reset_password` | Send password reset to a user | branch, all |  | Own, Adm, Br b |
| `roles.list` | List roles | all |  | Own, Adm, Br, Aud |
| `roles.view` | View a role and its permissions | all |  | Own, Adm, Br, Aud |
| `roles.create` | Create custom roles | all |  | Own, Adm |
| `roles.update` | Edit custom roles | all |  | Own, Adm |
| `roles.delete` | Delete custom roles | all |  | Own, Adm |
| `roles.assign` | Assign roles to users | branch, all |  | Own, Adm, Br b |
| `permissions.list` | List the permission catalogue | all |  | Own, Adm, Aud |
| `sessions.revoke` | Sign other users out | branch, all |  | Own, Adm, Br b |
| `audit.view` | View the audit log | all | S | Own, Adm, Aud |
| `organisation.view` | View business profile | all |  | Own, Adm, Br, Acc, Aud |
| `organisation.update` | Edit business profile | all |  | Own, Adm |
| `branches.list` | List branches | branch, all |  | Own, Adm, Br b, Rnt b, Flt b, Sal b, Csh b, Acc, Aud |
| `branches.view` | View a branch | branch, all |  | Own, Adm, Br b, Rnt b, Flt b, Sal b, Csh b, Acc, Aud |
| `branches.create` | Create branches | all |  | Own, Adm |
| `branches.update` | Edit branches | branch, all |  | Own, Adm, Br b |
| `branches.deactivate` | Deactivate or reactivate branches | all |  | Own, Adm |
| `settings.view` | View settings | all |  | Own, Adm, Br, Flt, Acc, Aud |
| `settings.update` | Edit general settings | all |  | Own, Adm |
| `settings.numbering.manage` | Edit document numbering | all |  | Own, Adm |
| `settings.currency.manage` | Edit currency settings | all |  | Own, Adm, Acc |
| `settings.tax.manage` | Edit tax settings | all | S | Own, Adm, Acc |
| `settings.notifications.manage` | Set up the SMS provider, quiet hours and notification rules | all | S | Own, Adm |
| `settings.mobile.connect` | Show the mobile-app connect QR code | all |  | Own, Adm |
| `finance.invoices.view` | View invoices | branch, all |  | Own, Adm, Br b, Csh b, Acc, Aud |
| `finance.invoices.manage` | Draft, edit and issue invoices | branch, all |  | Own, Adm, Br b, Acc |
| `finance.invoices.void` | Void issued invoices | branch, all | S | Own, Adm, Acc |
| `finance.payments.view` | View payments and receipts | branch, all |  | Own, Adm, Br b, Csh b, Acc, Aud |
| `finance.payments.record` | Record payments received and made, and allocate them | branch, all |  | Own, Adm, Br b, Csh b, Acc |
| `finance.payments.reverse` | Reverse payments and release allocations | branch, all | S | Own, Adm, Acc |
| `finance.cash_sessions.manage` | Open and close your own cash session | branch, all |  | Own, Adm, Br b, Csh b, Acc |
| `finance.cash_sessions.view` | See every cash session and close others' sessions | branch, all |  | Own, Adm, Br b, Acc, Aud |
| `finance.ledger.view` | See the ledger, trial balance and party accounts | all | S | Own, Adm, Acc, Aud |
| `finance.accounts.manage` | Add ledger accounts | all |  | Own, Adm, Acc |
| `finance.export` | Export journals for an accounting package and map its accounts | all | S | Own, Adm, Acc |
| `finance.reconcile` | Import bank and mobile money statements, match them and post what the books lack | all | S | Own, Adm, Acc |
| `finance.period.lock` | Lock and unlock accounting periods | all | S | Own, Adm, Acc |
| `finance.settings.manage` | Edit finance settings | all |  | Own, Adm, Acc |
| `finance.fx_rates.view` | View exchange rates | all |  | Own, Adm, Acc, Aud |
| `finance.fx_rates.manage` | Enter and remove exchange rates | all |  | Own, Adm, Acc |
| `finance.payables.view` | See what is owed to suppliers: aged payables, open bills and statements | all |  | Own, Adm, Acc, Aud |
| `finance.fx_rates.override` | Use another exchange rate than the one entered for the day on a document | all |  | Own, Adm, Acc |
| `expenses.list` | List expenses (own: only those you entered) | own, branch, all |  | Own, Adm, Br b, Flt b, Csh b, Acc, Aud |
| `expenses.view` | Open expenses with receipts (own: only those you entered) | own, branch, all |  | Own, Adm, Br b, Flt b, Csh b, Acc, Aud |
| `expenses.create` | Enter, correct and submit expenses | branch, all |  | Own, Adm, Br b, Flt b, Acc |
| `expenses.approve` | Approve or reject expenses (up to the role's max_amount_minor limit) | branch, all |  | Own, Adm, Br b, Acc |
| `expenses.pay` | Pay approved expenses | branch, all |  | Own, Adm, Br b, Csh b, Acc |
| `expenses.void` | Void unpaid expenses | branch, all | S | Own, Adm, Acc |
| `expenses.fuel.record` | Record fuel fills | branch, all |  | Own, Adm, Br b, Flt b, Acc |
| `expenses.rules.manage` | Set expense approval rules | all |  | Own, Adm, Acc |
| `expenses.recurring.manage` | Set up recurring expenses | all |  | Own, Adm, Acc |
| `expenses.budgets.view` | See budgets and spending against them | all |  | Own, Adm, Br, Acc, Aud |
| `expenses.budgets.manage` | Set budgets | all |  | Own, Adm, Acc |
| `expenses.categories.manage` | Create, rename and deactivate expense categories | all |  | Own, Adm, Acc |
| `vehicles.list` | List vehicles | branch, all |  | Own, Adm, Br b, Rnt b, Flt b, Acc, Aud |
| `vehicles.view` | Open a vehicle, its photos and timeline | branch, all |  | Own, Adm, Br b, Rnt b, Flt b, Acc, Aud |
| `vehicles.create` | Register vehicles | branch, all |  | Own, Adm, Br b, Flt b |
| `vehicles.update` | Edit vehicles, move them between branches and groups | branch, all |  | Own, Adm, Br b, Flt b |
| `vehicles.delete` | Remove mistaken vehicle entries | branch, all |  | Own, Adm, Br b |
| `vehicles.change_status` | Change a vehicle's status by hand | branch, all |  | Own, Adm, Br b, Flt b |
| `vehicles.assign_driver` | Assign drivers to vehicles, hand over and end assignments | branch, all |  | Own, Adm, Br b, Flt b |
| `vehicles.import` | Import vehicles from CSV | branch, all |  | Own, Adm, Br b, Flt b |
| `vehicles.export` | Export the vehicle register | branch, all |  | Own, Adm, Br b, Flt b, Acc |
| `vehicles.documents.view` | View vehicle documents and compliance | branch, all |  | Own, Adm, Br b, Flt b, Acc, Aud |
| `vehicles.documents.manage` | Add, renew and remove vehicle documents | branch, all |  | Own, Adm, Br b, Flt b |
| `vehicles.odometer.record` | Record odometer readings | branch, all |  | Own, Adm, Br b, Flt b |
| `vehicles.photos.manage` | Upload and remove vehicle photos | branch, all |  | Own, Adm, Br b, Flt b |
| `vehicles.financials.view` | See and edit vehicle cost, residual and book value | branch, all | S | Own, Adm, Br b, Acc, Aud |
| `vehicles.groups.manage` | Create, rename and delete vehicle groups | all |  | Own, Adm |
| `vehicles.issues.view` | See issues reported on vehicles (breakdowns, accidents …) | branch, all |  | Own, Adm, Br b, Flt b, Aud |
| `vehicles.issues.manage` | Log, acknowledge and resolve vehicle issues | branch, all |  | Own, Adm, Br b, Flt b |
| `vehicles.damages.manage` | Record vehicle damages, settle who pays (charging renters), and mark them repaired | branch, all |  | Own, Adm, Br b, Flt b |
| `maintenance.view` | See service plans, what is due on each vehicle and its service history | branch, all |  | Own, Adm, Br b, Flt b, Aud |
| `maintenance.plans.manage` | Manage service plans and their tasks (intervals by km and days) | all |  | Own, Adm |
| `maintenance.work_orders.manage` | Run work orders and record services done on vehicles | branch, all |  | Own, Adm, Br b, Flt b |
| `incidents.view` | See incidents, insurance claims, traffic offences and fuel anomalies on vehicles | branch, all |  | Own, Adm, Br b, Flt b, Aud |
| `incidents.manage` | Report and close incidents, run insurance claims, record and settle traffic offences and review fuel anomalies | branch, all |  | Own, Adm, Br b, Flt b |
| `telematics.view` | See trackers on the live map, vehicles' tracks and trips, telematics events and utilisation from ignition | branch, all |  | Own, Adm, Br b, Flt b, Aud |
| `telematics.events.manage` | Acknowledge geofence and over-speed events | branch, all |  | Own, Adm, Br b, Flt b |
| `telematics.manage` | Connect telematics providers, link trackers to vehicles, set the speed limit and retention, and manage geofences | all |  | Own, Adm |
| `parts.manage` | Manage the parts catalogue and the branch's stock (opening, purchases, counts, transfers) | branch, all |  | Own, Adm, Br b, Flt b |
| `purchases.view` | See vehicle purchases, their costs, landed cost and import timeline | branch, all |  | Own, Adm, Br b, Flt b, Acc, Aud |
| `purchases.create` | Draft purchases and keep their import timeline, shipping and documents | branch, all |  | Own, Adm, Br b, Flt b |
| `purchases.approve` | Order purchases (the vehicles' prices become bills) and cancel them | branch, all |  | Own, Adm, Br b |
| `purchases.costs.manage` | Add and remove a purchase's cost components | branch, all |  | Own, Adm, Br b, Acc |
| `purchases.receive` | Receive a purchase's vehicles into the fleet (with vehicles.create) | branch, all |  | Own, Adm, Br b, Flt b |
| `dealer.stock.list` | List dealer stock and its ageing | branch, all |  | Own, Adm, Br b, Flt b, Sal b, Acc, Aud |
| `dealer.stock.view` | Open a stock vehicle with its price and transfer history | branch, all |  | Own, Adm, Br b, Flt b, Sal b, Acc, Aud |
| `dealer.stock.create` | Take vehicles into stock (bought, traded in, on consignment …) | branch, all |  | Own, Adm, Br b, Flt b |
| `dealer.stock.update` | Move stock through reconditioning, set holding cost and consignment terms | branch, all |  | Own, Adm, Br b, Flt b |
| `dealer.stock.list_for_sale` | Put stock on sale and take it off sale | branch, all |  | Own, Adm, Br b |
| `dealer.stock.withdraw` | Withdraw vehicles from stock | branch, all |  | Own, Adm, Br b |
| `dealer.stock.transfer` | Transfer stock between branches (both branches) | branch, all |  | Own, Adm, Br b, Flt b |
| `dealer.stock.cost.view` | See stock cost, minimum prices and margins | branch, all |  | Own, Adm, Br b, Acc, Aud |
| `dealer.stock.price.manage` | Set asking and minimum prices | branch, all |  | Own, Adm, Br b |
| `dealer.leads.view` | See leads with their activity and tasks (own: those assigned to you) | own, branch, all |  | Own, Adm, Br b, Sal o, Aud |
| `dealer.leads.create` | Capture leads (and take leads given to you there) | branch, all |  | Own, Adm, Br b, Sal b |
| `dealer.leads.update` | Work leads: details, stages, activity and follow-ups (own: yours) | own, branch, all |  | Own, Adm, Br b, Sal o |
| `dealer.leads.assign` | Give leads to sales staff and set the branch's lead rotation | branch, all |  | Own, Adm, Br b |
| `dealer.testdrives.manage` | Book test drives and hand the cars out and back | branch, all |  | Own, Adm, Br b, Sal b |
| `dealer.quotes.manage` | Prepare, send and record the answer to sales quotes | branch, all |  | Own, Adm, Br b, Sal b |
| `dealer.appraisals.manage` | Appraise vehicles offered in part exchange | branch, all |  | Own, Adm, Br b, Sal b |
| `dealer.deals.view` | See vehicle sales with their payments and documents (own: those you sell) | own, branch, all |  | Own, Adm, Br b, Sal o, Csh b, Acc, Aud |
| `dealer.deals.create` | Draft, reserve, sell and cancel vehicle sales | branch, all |  | Own, Adm, Br b, Sal b |
| `dealer.deals.discount` | Give a discount on a sale, up to the role's max_percent (default 5%) without approval | branch, all |  | Own, Adm, Br b, Sal b |
| `dealer.deals.approve` | Approve a sale below the minimum price or with a discount over the seller's limit | branch, all | S | Own, Adm, Br b |
| `dealer.deals.payments.record` | Record deposits and payments on sales, and the bank's loan | branch, all |  | Own, Adm, Br b, Csh b |
| `dealer.deals.deliver` | Hand a sold vehicle over to its buyer | branch, all |  | Own, Adm, Br b, Sal b |
| `dealer.commissions.view` | See sales commission statements (own: your own) | own, branch, all |  | Own, Adm, Br b, Sal o, Acc, Aud |
| `dealer.commissions.manage` | Set commission plans and splits, pay commissions out and claw them back | all | S | Own, Adm, Acc |
| `settings.vehicles.manage` | Edit vehicle settings (required documents, custom fields) | all |  | Own, Adm |
| `drivers.list` | List drivers | branch, all |  | Own, Adm, Br b, Flt b, Csh b, Aud |
| `drivers.view` | Open a driver with their guarantors | branch, all |  | Own, Adm, Br b, Flt b, Csh b, Aud |
| `drivers.create` | Register drivers | branch, all |  | Own, Adm, Br b, Flt b |
| `drivers.update` | Edit drivers, guarantors and documents; activate and rehire | branch, all |  | Own, Adm, Br b, Flt b |
| `drivers.delete` | Remove mistaken driver entries | branch, all |  | Own, Adm, Br b |
| `drivers.suspend` | Suspend and reinstate drivers | branch, all |  | Own, Adm, Br b, Flt b |
| `drivers.terminate` | Terminate drivers | branch, all |  | Own, Adm, Br b |
| `drivers.documents.view` | See drivers' and guarantors' identity documents and Ghana Card numbers | branch, all | S | Own, Adm, Br b, Aud |
| `drivers.app_access.manage` | Give drivers a driver-app login and take it away | branch, all | S | Own, Adm, Br b |
| `driver_app.use` | Use the driver app: own vehicle, ledger, remittances, fuel and issue reports (the Driver role) | own |  | Drv o |
| `drivers.ledger.view` | See drivers' ledgers, statements and shortfalls | branch, all | S | Own, Adm, Br b, Acc, Aud |
| `drivers.ledger.adjust` | Charge drivers (deductions) or credit them (bonuses) | branch, all | S | Own, Adm, Acc |
| `remittances.list` | List remittances | branch, all |  | Own, Adm, Br b, Flt b, Csh b, Acc, Aud |
| `remittances.view` | Open a remittance with its submissions | branch, all |  | Own, Adm, Br b, Flt b, Csh b, Acc, Aud |
| `remittances.submit` | Declare what a driver paid (for approval) | branch, all |  | Own, Adm, Br b, Flt b, Acc |
| `remittances.record` | Record remittance money received directly | branch, all |  | Own, Adm, Br b, Csh b, Acc |
| `remittances.approve` | Confirm or reject declared remittances | branch, all |  | Own, Adm, Br b, Acc |
| `remittances.waive` | Waive remittance shortfalls | branch, all | S | Own, Adm, Acc |
| `operations.board.view` | See the daily operations board | branch, all |  | Own, Adm, Br b, Flt b, Acc, Aud |
| `notifications.deliveries.view` | See the log of SMS, push and email notifications sent | all |  | Own, Adm, Aud |
| `workpay.view` | See work and pay agreements, their schedules and guarantors | branch, all |  | Own, Adm, Br b, Csh b, Acc, Aud |
| `workpay.create` | Draft work and pay agreements and send them for signature | branch, all |  | Own, Adm, Br b |
| `workpay.activate` | Start signed agreements (hand the vehicle over) and cancel unstarted ones | branch, all | S | Own, Adm, Br b |
| `workpay.payment.record` | Record work and pay deposits and instalments | branch, all |  | Own, Adm, Br b, Csh b, Acc |
| `workpay.penalty.waive` | Waive work and pay late fees and instalments | branch, all | S | Own, Adm, Br b |
| `workpay.restructure` | Give payment holidays, restructure schedules, take the vehicle off the road and quote special settlement discounts | branch, all | S | Own, Adm, Br b |
| `workpay.terminate` | Terminate agreements and repossess vehicles, with the settlement figures | branch, all | S | Own, Adm, Br b |
| `workpay.transfer.manage` | Correct transfer letters of paid-up agreements and track the DVLA change of ownership | branch, all |  | Own, Adm, Br b |
| `workpay.settings.manage` | Change work and pay defaults (frequency, grace, rounding, deposit rule) | all |  | Own, Adm |
| `rentals.view` | See rental classes, rate plans and extras, availability and the rental calendar, and price rentals | branch, all |  | Own, Adm, Br b, Rnt b, Acc, Aud |
| `rentals.create` | Book and hold vehicles for customers and move class bookings between vehicles | branch, all |  | Own, Adm, Br b, Rnt b |
| `rentals.update` | Change, confirm, extend and close rental bookings | branch, all |  | Own, Adm, Br b, Rnt b |
| `rentals.checkout` | Hand rental vehicles over to customers (check-out) | branch, all |  | Own, Adm, Br b, Rnt b |
| `rentals.checkin` | Take rental vehicles back (check-in) with their odometer and fuel | branch, all |  | Own, Adm, Br b, Rnt b |
| `rentals.cancel` | Cancel rental bookings and mark no-shows (policy fees apply) | branch, all |  | Own, Adm, Br b, Rnt b |
| `rentals.payments.record` | Take rental payments and security deposits, apply deposits to invoices and return them | branch, all |  | Own, Adm, Br b, Rnt b |
| `rentals.discount.apply` | Give rental discounts, up to the role's max_percent (or the rental settings' maximum) | branch, all |  | Own, Adm, Br b, Rnt b |
| `rentals.price.override` | Agree a rental price other than the rates, and discounts beyond the limit | branch, all | S | Own, Adm |
| `rentals.rate_plans.manage` | Manage vehicle classes, rate plans and seasons, extras, zones, promo codes, holidays and rental pricing settings | all |  | Own, Adm |
| `documents.list` | List issued documents | branch, all |  | Own, Adm, Br b, Rnt b, Flt b, Sal b, Acc, Aud |
| `documents.view` | Open and download issued documents | branch, all |  | Own, Adm, Br b, Rnt b, Flt b, Sal b, Acc, Aud |
| `documents.issue` | Issue documents (handover notes, agreements …) | branch, all |  | Own, Adm, Br b, Rnt b, Flt b |
| `documents.attach_paper` | Record signatures made on paper by attaching the signed scan | branch, all |  | Own, Adm, Br b, Rnt b |
| `documents.void` | Void issued documents | branch, all | S | Own, Adm |
| `documents.templates.view` | See document templates | all |  | Own, Adm, Br, Acc, Aud |
| `documents.templates.manage` | Edit document templates and put versions in use (locked clauses stay) | all | S | Own, Adm |
| `dashboards.overview.view` | See the business overview: revenue, costs and cash collected | branch, all |  | Own, Adm, Br b, Acc, Aud |
| `dashboards.vehicles.view` | See vehicle profit and loss and utilisation | branch, all |  | Own, Adm, Br b, Acc, Aud |
| `dashboards.remittances.view` | See the remittance collection dashboard | branch, all |  | Own, Adm, Br b, Flt b, Acc, Aud |
| `dashboards.expenses.view` | See the expense dashboard | branch, all |  | Own, Adm, Br b, Acc, Aud |
| `dashboards.workpay.view` | See the work and pay portfolio: collections, arrears (PAR), ageing and the collections forecast | branch, all |  | Own, Adm, Br b, Acc, Aud |
| `dashboards.rentals.view` | See the rental reports: utilisation, revenue, average daily rate, balances and deposits held, damage costs | branch, all |  | Own, Adm, Br b, Acc, Aud |
| `dashboards.maintenance.view` | See the maintenance KPIs (cost per vehicle and km, downtime, preventive work, failures) and the compliance dashboard | branch, all |  | Own, Adm, Br b, Flt b, Acc, Aud |
| `dashboards.dealer.view` | See the dealer reports: sales, stock and leads at a glance, price reductions, cash collected on sales against what they owe and deposits held | branch, all |  | Own, Adm, Br b, Acc, Aud |
| `dashboards.stats.rebuild` | Rebuild the vehicle statistics behind the dashboards | all |  | Own, Adm, Acc |
| `customers.list` | List customers | all |  | Own, Adm, Br, Rnt, Sal, Csh, Acc, Aud |
| `customers.view` | Open a customer | all |  | Own, Adm, Br, Rnt, Sal, Csh, Acc, Aud |
| `customers.create` | Register customers | all |  | Own, Adm, Rnt, Sal |
| `customers.update` | Edit customers and their documents | all |  | Own, Adm, Rnt, Sal, Acc |
| `customers.delete` | Remove mistaken customer entries | all |  | Own, Adm |
| `customers.blacklist` | Put customers on watch, blacklist or clear them | all |  | Own, Adm |
| `customers.id_documents.view` | See customers' identity documents and Ghana Card numbers | all | S | Own, Adm, Aud |
| `suppliers.list` | List suppliers | all |  | Own, Adm, Br, Flt, Acc, Aud |
| `suppliers.view` | Open a supplier | all |  | Own, Adm, Br, Flt, Acc, Aud |
| `suppliers.create` | Add suppliers | all |  | Own, Adm, Acc |
| `suppliers.update` | Edit and deactivate suppliers | all |  | Own, Adm, Acc |
| `suppliers.delete` | Remove mistaken supplier entries | all |  | Own, Adm |
| `suppliers.payments.make` | Record one payment for several of a supplier's approved bills | all |  | Own, Adm, Acc |
| `reports.schedules.manage` | Send reports on a schedule to users of the business (own: the schedules they set up) | own, all |  | Own, Adm, Br o, Acc |
| `data.export` | Export all the business's data (a zip emailed as a link) | all | S | Own |
| `legal.accept` | Accept new terms and privacy policy for the business | all |  | Own |
| `support.tickets.view_all` | See every support ticket of the business, not only your own | all |  | Own, Adm |
| `integrations.view` | See the business's API keys, webhooks and their deliveries | all |  | Own, Adm, Aud |
| `integrations.manage` | Create and revoke API keys and manage webhooks | all | S | Own, Adm |
| `billing.view` | View subscription and invoices | all |  | Own, Adm, Acc, Aud |
| `billing.manage` | Pay, change plan, request extensions | all | S | Own |
