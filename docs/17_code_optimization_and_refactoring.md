# 17 — Code Optimization & Refactoring Plan

> **Update 2026-10-13:** with the move to PostgreSQL and no data to migrate, the persistence layer is **rewritten** rather than patched ([22 §9](22_postgresql_architecture.md)). Mongo-specific quick fixes in §1 (H1, H2, H8, H14–H17) are moot. §2 (single DI container), §5 (validation/DTOs), §6 (errors), §10 (logging/config), §12 (tooling), §13 (tests) carry over. §3 base repository now targets Postgres (keyset pagination or `COUNT(*) OVER()`). §14 strangler approach is replaced by the rewrite plan in 22 §9.

Concrete, incremental changes. Each item lists the problem, the change, and the payoff. Ordered roughly by value / risk.

## 1. Quick fixes (bugs from doc 01, small diffs)

| Ref | Change |
|---|---|
| H1 | `TenantModelFactory`: `ExpenseCategory: createExpenseCategoryModel(connection)` |
| H2 | Use `getTenantContext().connection.startSession()` (or a `withTransaction(fn)` helper bound to tenant connection) |
| H3/H4/H5/H6 | W&P: check completion on the *updated* agreement; allow final payment < installment; `await` lookup; persist `recordedBy`; `createdBy = req.user._id` |
| H7 | Drop `unique` on `vehicleId`/`vehicle` in agreements → partial unique on active statuses |
| H8 | `date: { type: Date, default: Date.now }` (function, not value) |
| H9 | Single `VehicleStatus` enum shared by schema/TS; release vehicle on rental completion |
| H12 | Return actual number of weeks / use day buckets |
| H14 | Replace `new mongoose.SchemaTypes.ObjectId(x)` / `Schema.Types.ObjectId(x)` with `new mongoose.Types.ObjectId(x)` (validate with `isValidObjectId` first) |
| H16 | `sparse: true` (or partial index) on optional unique fields |
| H17 | Soft-delete filter on `findOne`, `findOneAndUpdate`, `updateOne/Many` too |
| C8 | Remove `Tenant` from tenant models; fix admin path check |
| — | Add `mongoose` to `dependencies`; remove `@types/mongoose` (Mongoose ships its own types) |
| — | Remove duplicated W&P route; re-enable permission checks |

## 2. Composition root & DI

**Problem**: 15 route files each build their own `Container`, re-binding the same classes.
**Change**: per-module `ContainerModule` + one container in `bootstrap/container.ts`; routes receive controllers from it. Optionally adopt `inversify-express-utils` controllers (already installed) or keep explicit routers — but one container.
**Payoff**: singletons shared, less boilerplate, testable wiring, ~40% less route code.

## 3. Base repository

Every repository repeats: get model from context → build regex search → skip/limit → map → countDocuments → maybe aggregate sum.

```ts
abstract class TenantRepository<TDoc, TEntity> {
  protected abstract modelName: keyof TenantModels;
  protected abstract toEntity(doc: TDoc): TEntity;
  protected model() { return getTenantModels()[this.modelName]; }
  async findById(id, opts?) { ... lean() ... }
  async paginate(filter, { page, pageSize, sort, populate, sumField }) {
    // single $facet aggregation: data + total + sum in one round-trip
  }
  async create(data, session?) / update(id, patch, expectedVersion?) / softDelete(id)
}
```
- `$facet` pagination replaces 3 queries with 1.
- `.lean()` on reads (5–10× less memory/CPU than hydrated docs).
- Policy filter (branch/own scope — doc 16) applied centrally.
- Remove `try { … } catch (e) { throw e }` noise.

## 4. Query building & search

- `QueryBuilder` from validated query DTOs: equality filters, date ranges on the module's business date, `in` lists, sort whitelist.
- Escape regex input; prefer anchored prefix regex on indexed fields or Atlas Search.
- Cursor-based pagination option for mobile infinite scroll (`?after=<id>`).

## 5. Validation & DTO separation

- zod schemas per endpoint; `validate({ body, query, params })` middleware.
- Entities stop being "bags of optionals". Required fields are required.
- Response DTO mappers per endpoint (and per permission for sensitive fields).
- Replace class-with-constructor-of-20-positional-params entities (easy to misorder, e.g. `ICompany` constructor vs `toEntity` order) with interfaces/`type` + factory functions.

## 6. Error handling

- `DomainError(code, message, details)` subclasses map to HTTP in one place.
- Stop throwing plain `Error("Rental not found")` from repositories (becomes 500). Return `null` → use-case throws `NotFoundError`.
- `express-async-errors` or a wrapper to remove `try/catch/next` boilerplate in controllers.

## 7. Transactions & consistency

- `withTenantTransaction(async (session) => …)` helper; use for: booking + block, payment + allocations + agreement update, receiving purchase + vehicle create, deal delivery.
- Optimistic concurrency (`version`) on aggregates with balances.
- Outbox written in the same transaction (doc 03 §7).

## 8. Codes / numbering

Replace all "find last + 1" hooks (H15) with the `counters` service (doc 05 §1.2). Delete the 8 copy-pasted pre-save hooks.

## 9. Performance

| Area | Change |
|---|---|
| Indexes | Declare per doc 05; `syncIndexes` via migrations; `autoIndex: false` in prod |
| Populate | Select only needed fields; avoid populating `createdBy`/`updatedBy` on list endpoints (return ids + names snapshot) |
| N+1 | Batch lookups (`$in`) where loops call repos |
| Connections | `useDb()` on shared cluster connection instead of `createConnection` per tenant (doc 04 §8) |
| Payloads | Stop base64 image uploads in JSON → pre-signed direct uploads; compress responses (`compression`) |
| Dashboards | Read models + short Redis cache |
| CPU | Async bcrypt; avoid `JSON.stringify` of big objects in headers |
| Tenant lookup | Cache tenant by host in Redis/in-memory LRU (TTL 60s) — today every request hits the system DB |

## 10. Logging & config

- Logger with child context (`requestId`, `tenantId`, `userId`), JSON output, redaction.
- Replace `console.log` calls (ErrorMiddleware, ConnectionManager, server).
- `config` validated with zod at boot; typed; no silent defaults for secrets. Fix naming (`cloudinaryApiSecrete` → `cloudinaryApiSecret`, mail host vs service).

## 11. Naming & typos (do during v1 → v2 API transition)

`lisenceExpiryDate` → `licenceExpiryDate`, `encriptPassword` → `hashPassword`, `DashboardRequestQery`, `view:vehi-cle`, `TenantProvisionalServiceImpl.ts` → `TenantProvisioningServiceImpl.ts`, `IExpenseRespository.ts`. Keep v1 request/response field aliases for the mobile app until it migrates.

## 12. Tooling

- ESLint (typescript-eslint, import/boundaries), Prettier, `tsc --noEmit` in CI.
- Husky pre-commit: lint-staged + typecheck (drop building `dist` on every commit; build in CI/CD).
- GitHub Actions: install → lint → typecheck → unit → integration (mongodb-memory-server replset) → build → deploy staging.
- `strict: true` is already on — keep it, and reduce the many `as any` casts (tenant context, provisioning, mappers).
- Remove unused deps (`inversify-express-utils` if not adopted), add `helmet`, `zod`, `pino`/keep winston, `bullmq`, `ioredis`.
- Docker Compose for local: Mongo replica set (transactions), Redis, Mailpit.
- Seed script: demo tenant with realistic data for each segment.

## 13. Testing debt

- Existing tests: rental + W&P interactor unit tests — extend to cover every H-bug as regression.
- Add integration tests per repository against in-memory Mongo with tenant context.
- Add API isolation tests (doc 16 §6).
- Target: domain logic ≥ 90% coverage (pricing, schedules, allocation, state machines); overall ≥ 70%.

## 14. Strangler approach

Don't big-bang rewrite. For each module:
1. Fix critical bugs in place (P0).
2. Introduce the new module folder alongside (`modules/rentals`), new `/api/v1` routes.
3. Migrate data with a versioned migration.
4. Point old routes at new use-cases (adapters translate old payloads).
5. Delete old code once clients moved.
