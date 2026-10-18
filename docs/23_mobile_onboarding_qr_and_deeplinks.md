# 23 — Mobile Onboarding: QR Code & Deep Links

Decision 18: shared domain; the web portal shows a **QR code containing the backend URL**; scanning it also triggers a **deep link** that opens the app, or sends the user to download it.

## 1. Interpretation to confirm (open question in doc 19)

"Shared domain" is read here as: **one API domain serves all tenants** (e.g. `api.<domain>`), the tenant is identified by the token / an `X-Tenant` header rather than by a per-tenant API host. The web portal may still use `<slug>.<domain>` for the browser UI. If you intended per-tenant API subdomains (`<slug>.api.<domain>`), the flows below still work — only the URL in the QR changes.

## 2. Goals

1. A staff member or driver installs the app and connects it to the right business in one scan.
2. Works whether or not the app is already installed.
3. The app can't be tricked into talking to an attacker's server.

## 3. Flow

```
Web portal (logged-in owner/manager)
  Settings → Connect mobile app → shows QR  +  "copy link" + "share via WhatsApp/SMS"

Phone camera scans QR  →  opens   https://<link-domain>/connect?...      (HTTPS universal link)
   ├─ App installed → OS opens the app directly with the parameters (Android App Links / iOS Universal Links)
   └─ App not installed → landing page → "Get the app" (Play Store / App Store)
                          after install + first open → app reads the pending connect params
                          (Android: Play Install Referrer; iOS: deferred deep link via a provider or clipboard fallback)

App receives params → validates → GET /api/v1/public/tenant-config → shows "Connect to <Business name>?" → user confirms
   → stores {apiBaseUrl, tenantSlug} → login screen (email/phone + password, or invite acceptance)
```

Also support **in-app scanning** (Settings → Scan QR) using the same payload, for when the app is already open or the phone's camera app doesn't open links.

## 4. QR / link payload

Single HTTPS URL (so a normal camera works, and a normal browser shows a fallback page):

```
https://<link-domain>/connect?v=1&api=https%3A%2F%2Fapi.<domain>&t=<tenantSlug>&sig=<signature>
```

| Param | Meaning |
|---|---|
| `v` | Payload version |
| `api` | Backend base URL |
| `t` | Tenant slug (public identifier, not a secret) |
| `sig` | Signature over `v|api|t` by the platform's private key. The app embeds the public key and verifies it |

- The QR is **not a credential**. Everyone must still log in. Optionally an **invitation token** (`inv=`) can be included in a separate, time-limited QR/link generated when inviting a specific user (doc 16 invitations): scanning opens the app straight to "Set your password".
- Custom URL scheme `autoforce://connect?...` (same params) is the fallback for in-app scanner and environments where universal links are blocked.

## 5. Security

| Threat | Control |
|---|---|
| Malicious QR points the app at a rogue backend to harvest passwords | Signature check with embedded public key **and** host allow-list (`*.<domain>` plus platform-registered enterprise custom domains). Reject anything else, show a clear error |
| Link hijacking on Android/iOS | Host `/.well-known/assetlinks.json` and `/.well-known/apple-app-site-association`; use verified App Links / Universal Links, not just custom schemes |
| Tampered printed QR stickers | Signature as above |
| Tenant enumeration via `tenant-config` | Return only minimal public data (name, logo, currency, min app version, auth methods). Rate limit. Unknown slug → generic error |
| Leaked invite QR | Invitation tokens single-use, short expiry (e.g. 72 h), revocable |
| Man-in-the-middle | HTTPS only; consider certificate pinning for the mobile app |

## 6. Public endpoint

```
GET /api/v1/public/tenant-config?slug=<tenantSlug>
→ {
    "tenant": { "slug": "acme-fleet", "name": "Acme Fleet", "logoUrl": "…", "status": "active" },   // active | trialing | past_due | deactivated | … plus `deactivationReason` and `billingOnlyAccess` — lets the app show a blocking screen, or the billing-only status screen with a link to the web portal's Billing tab (doc 25 §5.2)
    "currency": { "base": "GHS", "symbol": "₵" },
    "modules": ["fleet","remittances","workpay","rentals"],
    "auth": { "methods": ["password"], "invitationsOnly": true },
    "app": { "minVersion": "2.3.0", "latestVersion": "2.5.0", "storeUrls": { "android": "…", "ios": "…" } },
    "serverTime": "2026-10-13T09:00:00Z"
  }
```

- Used by the app at connect time and on each cold start (to force-update old app versions, show maintenance banners, and refresh branding).

## 7. Deferred deep linking options

| Option | Notes |
|---|---|
| Android **Play Install Referrer** | Free, reliable: pass the connect params in the Play Store URL `referrer=` |
| iOS | No official equivalent. Options: a deferred-deep-link provider (Branch, AppsFlyer OneLink, Adjust), or ask the user to re-scan after install (simple, acceptable for v1) |
| Firebase Dynamic Links | Discontinued by Google in 2025 — don't build on it |

Suggested v1: universal/app links + Android install referrer + "scan again after install" on iOS. Add a provider only if drop-off data justifies it.

## 8. Multi-tenant app behaviour

- A person may belong to several businesses (e.g. a driver for two fleets). The app stores a list of connections `{tenantSlug, apiBaseUrl}` and shows a **business switcher**.
- Every API call sends `Authorization: Bearer <token>` (contains `tid`) and `X-Tenant: <slug>`. Server rejects a mismatch (doc 04 §4).
- Changing business = switching the stored connection and token set, not logging out of everything.

## 9. Web portal pieces (for later, API support now)

- `GET /api/v1/mobile/connect-link` (permission `settings.mobile.connect`) → `{ url, qrPngBase64 | qrSvg }`, generated server-side so the signing key never reaches the browser.
- Invitation endpoint returns an optional `inviteLink` / QR for a user.
- Portal shows install count / last-seen app version per user (from `sessions`).

## 10. Open items

- Domain names: API domain, link domain, portal domain.
- Store listing names / bundle IDs (needed for `assetlinks.json` and AASA files).
- Whether the app must work with self-hosted/enterprise backends (affects the allow-list).

## 11. Payload format as built (P1-9) — for the mobile team

**Link** (put in the QR; also works as a normal link):

```
https://<MOBILE_LINK_BASE_URL>/connect?v=1&api=<url-encoded API base, ends with "/">&t=<slug>[&inv=<token>&exp=<unix seconds>]&k=<key id>&sig=<signature>
autoforce://connect?<same parameters>          (custom scheme: in-app scanner, fallback)
```

**Signed message** — UTF-8, lines joined with `\n`, in this exact order, empty value when absent:

```
autoforce-connect
v=1
api=https://api.example.com/
t=acme-fleet
inv=
exp=
k=k-42a93ac1f826
```

**Signature**: Ed25519 over that message, base64url (no padding). **Key id**: `k-` + first 12 hex
characters of SHA-256 of the raw 32-byte public key. The app embeds the trusted keys
(`{ keyId, publicKey }`, raw key base64url) from `yarn mobile:keygen` or
`GET /api/v1/public/mobile/connect-keys` at build time — never fetched at runtime.

**The app must, in order**: parse (path `/connect`, `v` = 1, known parameters only) → find the
key by `k` (unknown key: refuse) → verify `sig` → check the host of `api` against its built-in
allow-list → if `exp` is present, refuse when past → `GET {api}api/v1/public/tenant-config?slug={t}`
→ ask "Connect to <name>?" → store `{ api, t }` → with `inv`: open "Set your password"
(`POST /api/v1/auth/invitations/accept` with `X-Tenant: t`), otherwise the sign-in screen.

**Other pieces**: portal `GET /api/v1/mobile/connect-link` (permission `settings.mobile.connect`)
returns `{ url, appUrl, qrSvg, … }`; invitation emails contain a signed app link (`inv`, `exp`
= invitation expiry); `GET /connect` is the fallback page (open the app / get it — the Play Store
link carries a connect link *without* any invitation token as install referrer); app-link files
at `/.well-known/assetlinks.json` and `/.well-known/apple-app-site-association` (404 until the
store identifiers are configured); console diagnostics
`POST /api/platform/v1/mobile/connect-links/verify` (permission `platform.mobile.view`) runs the
same checks and reports the reason a link is refused.

