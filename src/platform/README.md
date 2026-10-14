# Platform (control plane)

Code that runs against the **`autoforce_platform` database**: tenants and provisioning, applications
and approval, subscriptions and billing, resellers, platform staff and the admin console API.
See `docs/22_postgresql_architecture.md` §2 and `docs/27_platform_admin_console.md`.

Rules (enforced by `eslint-plugin-boundaries`):

- May import `src/shared` and a tenant module's public `index.ts` (for example, to seed a new tenant).
- Never imports a module's inner layers or `src/bootstrap`.
- Tenant modules can never import this folder.
