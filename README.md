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
| `yarn test` / `yarn test:watch`     | Vitest                                                            |
| `yarn verify`                       | Typecheck, lint, format check and tests — run before every commit |

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
