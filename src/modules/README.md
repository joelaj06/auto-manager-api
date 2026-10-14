# Tenant business modules

Each folder here is one business module that runs **inside a tenant's database** (vehicles, rentals,
workpay, remittances, finance, …). See `docs/03_target_architecture.md` §1–2.

```
modules/<name>/
  domain/          entities with behaviour, value objects, state machines, domain events
  application/     use-cases (commands/queries) and ports (interfaces)
  infrastructure/  database repositories and external adapters
  http/            routes, controllers, request/response schemas
  index.ts         the module's public API — the only file other modules may import
  module.ts        wiring: creates the module's services from its dependencies
  permissions.ts   the module's permission manifest
```

Rules (enforced by `eslint-plugin-boundaries`, see `eslint.config.js`):

- `domain` imports nothing from `application`, `infrastructure` or `http`.
- `application` imports nothing from `infrastructure` or `http`.
- `infrastructure` imports nothing from `http`.
- Another module is used only through its `index.ts`.
- Modules never import `src/platform` (tenant code must not reach the control plane) or `src/bootstrap`.
