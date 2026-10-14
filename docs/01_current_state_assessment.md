# 01 — Current State Assessment

> **Update 2026-10-13:** the database is moving to PostgreSQL ([22](22_postgresql_architecture.md)). Findings H1, H2, H8, H14–H17 and C8 are Mongo/Mongoose-specific and disappear with the rewrite (22 §8). Security findings C1–C7 and business-logic bugs H3–H7, H9–H13, H18 still apply and must be fixed in the new modules.

Snapshot of `master` at commit `d2dc5b3` (2026-10-13). This is the baseline every other document builds on.

---

## 1. Stack

| Concern | Today |
|---|---|
| Runtime | Node + TypeScript 5.6, `ts-node-dev` for dev |
| HTTP | Express 4 |
| DI | Inversify 7 (+ `inversify-express-utils` installed but not really used) |
| DB | MongoDB via Mongoose **9.7.2** — ⚠️ Mongoose is *not* declared in `package.json` (only `@types/mongoose@5`); it is resolved transitively |
| Auth | JWT (`jsonwebtoken`), bcrypt |
| Files | Cloudinary (base64 upload) |
| Mail | Nodemailer (Gmail) |
| Logging | Winston |
| Tests | Jest + ts-jest (2 test files: rental, work-and-pay) |
| Deploy | Vercel (`vercel.json`, serverless `@vercel/node`) |

## 2. Architecture as-is

Clean-architecture flavoured layering:

```
src/
  entities/                 -> plain TS classes (IVehicle, IRental, ...) used as DTO + domain
  application/interactors/  -> use-cases (business rules)
  adapters/controllers/     -> Express handlers
  frameworks/
    database/mongodb/
      models/               -> Mongoose schemas + Mappers (toDtoCreation/toQuery/toEntity)
      repositories/         -> data access, pull models from tenant context
      system/               -> control-plane models (Tenant, Subscription, AuditLog)
      tenant/               -> TenantModelFactory (binds all models to a tenant connection)
      connection-manager/   -> per-tenant connection cache with idle eviction
    database/tenant-context -> AsyncLocalStorage holding {tenant, connection, models}
    webserver/              -> app, routes (one Inversify container PER route file), middleware
    services/               -> auth, mailer, storage bucket
```

### Request flow
1. `tenantResolutionMiddleware` reads `Host`, resolves subdomain → `Tenant` (system DB), checks status/subscription, gets/opens tenant connection, builds models, runs the rest of the request inside `AsyncLocalStorage`.
2. Route-level `AuthMiddleware.authenticateToken` verifies JWT, puts the **decoded token** on `req.user`.
3. `checkPermission(p)` checks `req.user.role.permissions` — i.e. permissions **embedded in the JWT**.
4. Controller → Interactor → Repository → `getTenantModels().X`.

### Multi-tenancy model
**Database-per-tenant** (`tenant_<slug>`) on the same cluster by default (`databaseUri` optional for dedicated clusters). System DB holds `Tenant`, `Subscription`, `AuditLog`. Inside each tenant DB there is still a `Company` collection and most documents carry a `company` field.

## 3. Module inventory

| Module | Endpoints | Notes |
|---|---|---|
| Auth | register, verifyOtp, login, resetPassword, verifyPasswordReset, changePassword | OTP by email |
| Users / Roles / Permissions | CRUD | Permissions are string constants (`utils/constants/permissions.ts`) |
| Company | CRUD | One per tenant in practice |
| Vehicles | CRUD | Embedded `salesHistory`, `maintenanceRecords`, `rentalHistory`, `insuranceDetails` (mostly unused) |
| Drivers | CRUD | Separate from User, but linked via `userId`/`user` |
| Sales | CRUD + approve/reject | Really **driver daily/weekly remittances**, not vehicle sales |
| Expenses + Categories | CRUD + status | pending/approved/rejected |
| Rentals | CRUD + extend / remove extension | Customer-based |
| Customers | CRUD | Renters |
| Work & Pay | create agreement, record payment, get by driver / id, payments list | Hire-purchase for drivers |
| Dashboard | summary, monthly sales by week | |
| Tenants (admin) | CRUD + activate/deactivate/suspend/renew | Provisioning creates DB, admin user, company, role, trial subscription |

---

## 4. Findings

### 4.1 🔴 Critical — security & tenant isolation

| # | Finding | Where | Impact |
|---|---|---|---|
| C1 | **JWT is not bound to a tenant.** All tenants share one `JWT_SECRET`, and the token carries the full user + role + permissions. A token issued on `tenant-a.app.com` is accepted on `tenant-b.app.com`. | `services/auth/authService.ts`, `middleware/AuthMiddleware.ts` | Cross-tenant data access with the attacker's own (admin) permissions. |
| C2 | **Platform admin routes only require *any* valid token.** `MANAGE_TENANTS` check is commented out. | `routes/tenantRoutes.ts:77` | Any tenant user can create / suspend / delete tenants. |
| C3 | **Public self-registration grants the Admin role.** `registerUser` looks up role `^admin` (case-insensitive regex) and assigns it. | `interactors/auth/AuthInteractorImpl.ts:254`, `RoleRepositoryImpl.findRoleByName` | Anyone who knows a tenant subdomain can create a full admin account (after email OTP). |
| C4 | Permissions are frozen inside a 30-day JWT. Revoking a role / deactivating a user has no effect until expiry. No refresh/revocation. | `authService.generateToken` | Can't lock out a fired employee. |
| C5 | Default `JWT_SECRET` fallback is `"secret"`. | `config/config.ts` | Forgeable tokens if env is missing. |
| C6 | Error middleware returns `stack` to clients and logs full `req.body` (including passwords on login/register). | `middleware/ErrorMiddleware.ts` | Info leak + secrets in logs. |
| C7 | Unescaped user input in `new RegExp(search)` across repositories. | Vehicle/Rental/Tenant/Role repos | ReDoS, and regex-injection on role lookup. |
| C8 | Tenant middleware bypass path is `/admin/tenants` but routes are `/api/admin/tenants` → the bypass never matches. On a tenant subdomain the admin routes run against that tenant's context; `TenantModelFactory` also exposes the **system** `Tenant` model to every tenant request. | `TenantResolutionMiddleware.ts`, `TenantModelFactory.ts:34` | Confusing control-plane boundary; tenant code can read/write the tenant registry. |
| C9 | CORS `origin: "*"`. | `webserver/app.ts` | Acceptable for a pure bearer-token API, but should be per-tenant allow-list once a web app exists. |

### 4.2 🟠 High — functional bugs

| # | Finding | Where |
|---|---|---|
| H1 | `ExpenseCategory: createExpenseModel(connection)` — the tenant factory maps **ExpenseCategory to the Expense model**. Expense categories are effectively broken in tenant context. | `tenant/TenantModelFactory.ts:24` |
| H2 | Work & Pay `recordPayment` uses `mongoose.startSession()` (the **default/system** connection) with tenant models. Transaction is either rejected or not covering the tenant writes. | `WorkAndPayRepositoryImpl.ts:104` |
| H3 | Work & Pay ownership transfer never fires: the repo already sets `status = "Completed"`, then the interactor checks `status !== "Completed"` before transferring the vehicle. | `WorkAndPayInteractorImpl.processPayment` |
| H4 | Work & Pay final payment can be impossible: `amount >= installmentAmount` **and** `amount <= balanceDue` — once `balanceDue < installmentAmount` (rounding via `Math.ceil`) no payment is valid. | same |
| H5 | `getPaymentsByAgreementId` doesn't `await` the agreement lookup → the not-found check never triggers. | same |
| H6 | Work & Pay `recordedBy` is not in the PaymentRecord schema → who took the money is lost. `createdBy` is set to the **company id**. | `paymentRecord.ts`, interactor |
| H7 | `vehicleId` is `unique` on agreements → a vehicle can never get a second agreement (e.g. after default/repossession). | `models/workandpay.ts` |
| H8 | Rental `date: { default: new Date() }` is evaluated **once at boot** → every rental gets the server start date. Rental list date filters use this field. | `models/rental.ts` |
| H9 | Vehicle `status` schema enum is `available / in-use / under-maintenance`, but code writes `Rented`, `Sold`; TS type has 7 different Title-Case values. `findByIdAndUpdate` skips validators so bad values persist. Vehicle is never released when a rental completes. | `models/vehicle.ts`, `entities/Vehicle.ts`, `RentalInteractorImpl` |
| H10 | Rental availability only checks current status — no date-range overlap, no reservations, no transaction between "mark vehicle rented" and "save rental". | `RentalInteractorImpl.addRental` |
| H11 | Rental `balance = amountPaid - totalAmount` (negative = owed) but `updateRental` recomputes from the old `totalAmount`; extension math flips sign conventions. No payment history — just a mutable `amountPaid`. | `RentalInteractorImpl` |
| H12 | Monthly sales chart uses `ceil(day/7)` → days 29–31 are "week 5", but the interactor only allocates 4 slots. | `SalesRepositoryImpl.getMonthlySales`, `DashboardInteractorImpl` |
| H13 | Dashboard filters sales/expenses by `date`, rentals by `createdAt`; counts drivers/vehicles by `company` string vs ObjectId inconsistently. Revenue = sales + rentals − expenses ignores work-and-pay. | `DashboardRepositoryImpl` |
| H14 | Several mappers build ids with `new mongoose.SchemaTypes.ObjectId(x)` / `mongoose.Schema.Types.ObjectId(x)` — that's a **SchemaType**, not an `ObjectId` value. Queries built with those never match. | `models/company.ts`, `user.ts`, `driver.ts`, `sales.ts`, `vehicle.ts`, `userOTP.ts` |
| H15 | Sequential codes (`VE-0000001`, `RT-…`) are generated by "find last + 1" in a pre-save hook → duplicates under concurrency (unique index then throws). Also breaks if the last doc was created with a custom code. | every model / `utils/baseModel.ts` |
| H16 | `Customer.email` is `unique` but optional (no `sparse`) → second customer without email fails. | `models/customer.ts` |
| H17 | Soft-delete filter only hooks `find`/`countDocuments`/`aggregate` — `findOne`/`findById` still return deleted docs. | all models |
| H18 | `TenantProvisioningService` has no rollback; a half-provisioned tenant DB is left behind. | `TenantProvisionalServiceImpl.ts` |

### 4.3 🟡 Medium — design / tech debt

- **One Inversify container per route file** (15 containers). The "real" container in `webserver/container.ts` is barely used; bindings are duplicated and singletons aren't shared.
- **Entities double as DTOs, queries and responses**; everything is optional (`?`), so the type system guarantees nothing.
- **No request validation** (several `//TODO validate data`). Controllers spread `req.body` straight into persistence (mass-assignment: e.g. a client could set `status`, `company`, `createdBy`).
- **Duplicated reference fields**: `Sale.driverId` + `Sale.driver`, `Driver.userId` + `Driver.user`, `Driver.vehicleId` + `Driver.vehicle`, `WorkAndPay.ownerId` + `owner` …; `Vehicle.ownerId` + `Vehicle.company`.
- **Unbounded embedded arrays** on Vehicle (`salesHistory`, `rentalHistory`, `maintenanceRecords`), Driver (`salesHistory`), Customer (`rentalHistory`). They duplicate data that lives in its own collection and grow forever.
- **Money as JS `Number`** (floating point). No currency field.
- **`Company` inside a tenant DB** is redundant with the Tenant itself unless it becomes "Branch".
- **Driver vs User**: two identities for one person; driver login story unclear.
- Pagination: `skip/limit` + separate `countDocuments` + sometimes a separate `aggregate` → 3 round-trips per list.
- No indexes declared beyond `unique`. Search uses prefix regex without supporting indexes.
- `bcrypt.hashSync/compareSync` inside async functions (blocks event loop).
- `ConnectionManager` idle timers + in-memory caches assume a long-lived process — at odds with **Vercel serverless** deployment.
- Pre-save hooks declare `next` and then don't call it (works in Mongoose 9 because async, but misleading).
- Typos baked into the API: `lisenceExpiryDate`, `encriptPassword`, `cloudinaryApiSecrete`, `DashboardRequestQery`, permission value `view:vehi-cle`.
- Work & Pay routes have permission checks commented out.
- Duplicate route: `GET /api/work-pay/agreement/:id/payments` registered twice.
- `dist/` is built in a pre-commit hook; `.qodo/` folder present.

## 5. What's good and worth keeping

- Clear separation into interactors / repositories — easy to evolve into proper modules.
- AsyncLocalStorage tenant context is the right primitive; repositories already pull models from it.
- `ConnectionManager` handles in-flight de-duplication and idle eviction sensibly.
- Provisioning flow (DB → user → company → role → subscription → audit → activate) is the right shape; it just needs idempotency + compensation.
- `withBaseSchema` is the seed of a shared model base (codes, soft delete, timestamps).
- Permission constants as a single source of truth.

See [17_code_optimization_and_refactoring.md](17_code_optimization_and_refactoring.md) for the remediation plan and [16_security_rbac_and_audit.md](16_security_rbac_and_audit.md) for the security fixes.
