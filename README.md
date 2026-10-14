# auto-manager-api

Backend for **Autoforce Manager** — a multi-tenant platform for vehicle businesses in Ghana: fleets and
driver remittances, Work & Pay (hire purchase), car rentals, dealerships, purchases, maintenance and
reporting. Each tenant gets its own PostgreSQL database.

> **Status:** version 2 is being rebuilt from scratch (Phase 0 — foundation). The previous MongoDB
> implementation was removed; it remains available in git history.
> Design and plan: [`docs/`](docs/00_index.md) — start with
> [`docs/30_implementation_plan.md`](docs/30_implementation_plan.md).

## Requirements

- Node.js 24 or newer (`.nvmrc`)
- Yarn 1.22
- Docker with Compose (for local PostgreSQL, Redis and Mailpit)

## Getting started

```bash
cp .env.example .env
yarn install
docker compose up -d
yarn dev
```

## Scripts

| Command                             | What it does                                                      |
| ----------------------------------- | ----------------------------------------------------------------- |
| `yarn dev`                          | Run the app with reload on change (tsx)                           |
| `yarn build`                        | Compile to `dist/`                                                |
| `yarn start`                        | Run the compiled app                                              |
| `yarn typecheck`                    | Type-check everything (`tsc --noEmit`)                            |
| `yarn lint` / `yarn lint:fix`       | ESLint, including architecture boundary rules                     |
| `yarn format` / `yarn format:check` | Prettier                                                          |
| `yarn test` / `yarn test:watch`     | Unit tests (Vitest)                                               |
| `yarn test:integration`             | Integration tests (`*.int.test.ts`, need `docker compose up -d`)  |
| `yarn verify`                       | Typecheck, lint, format check and tests — run before every commit |

## Continuous integration

GitHub Actions (`.github/workflows/`):

| Workflow                | When                            | What                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ci.yml`                | push to `master`, pull requests | typecheck, lint, format check, unit tests → integration tests (PostgreSQL + Redis services) → Docker image build, smoke test, vulnerability scan (fails on fixable critical/high), and on `master` publishes `ghcr.io/joelaj06/auto-manager-api` |
| `codeql.yml`            | push, pull requests, weekly     | Static security analysis                                                                                                                                                                                                                         |
| `dependency-review.yml` | pull requests                   | Blocks new dependencies with high/critical vulnerabilities                                                                                                                                                                                       |

Dependabot (`.github/dependabot.yml`) opens weekly update PRs for npm packages, the digest-pinned Docker base images and the SHA-pinned actions. No repository secrets are needed yet; deployment to staging is added with the VPS in P0-3.

## Project layout

```
src/
  bootstrap/   composition root and process entry point
  shared/      reusable kernel and infrastructure (config, …)
  platform/    control plane: tenants, billing, resellers, admin console
  modules/     tenant business modules (see src/modules/README.md)
```

Architecture rules are enforced by ESLint (`eslint.config.js`); see
[`docs/03_target_architecture.md`](docs/03_target_architecture.md).
