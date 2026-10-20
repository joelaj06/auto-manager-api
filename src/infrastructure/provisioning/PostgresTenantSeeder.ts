import { SELF_SERVICE_PERMISSIONS } from "../../application/authorization/permissionCatalog.js";
import { randomUUID } from "node:crypto";
import type { CatalogueSnapshot } from "../../application/ports/IPermissionCatalogueSource.js";
import type {
  CatalogueSyncResult,
  ITenantSeeder,
  SeedInput,
  TenantOwner,
} from "../../application/ports/ITenantSeeder.js";
import { OWNER_ROLE } from "../../application/authorization/tenantRoleTemplates.js";
import { standardTaxCodes } from "../../domain/tax/TaxTemplates.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";
import type { Queryable } from "../database/postgres/Queryable.js";

/** Default expense categories (docs/12); tenants add their own. */
const EXPENSE_CATEGORIES: readonly (readonly [string, string])[] = [
  ["fuel", "Fuel"],
  ["maintenance", "Maintenance & repairs"],
  ["tyres", "Tyres"],
  ["insurance", "Insurance"],
  ["licensing", "Licensing & permits"],
  ["tolls", "Road tolls"],
  ["parking", "Parking"],
  ["driver_allowance", "Driver allowances"],
  ["cleaning", "Cleaning"],
  ["office", "Office & administration"],
  ["other", "Other"],
];

/** Placeholders: inactive and without rates until the business sets them (decision 100). */
const TAX_PLACEHOLDERS: readonly (readonly [string, string])[] = [["WHT", "Withholding tax"]];

type Owner = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: TenantOwner["status"];
};

/**
 * Initial data and catalogue sync for one tenant database, in the caller's tenant unit of work.
 * Every statement is idempotent (upserts keyed by natural keys), so a retried provisioning or a
 * repeated sync is safe. After seeding, invariants are checked: exactly one owner, the owner role
 * holds every current permission, and the owner has it.
 */
export class PostgresTenantSeeder implements ITenantSeeder {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async seed(input: SeedInput): Promise<TenantOwner> {
    const tx = this.transactions.current();
    const o = input.organisation;
    await tx.query(
      `insert into organisation (name, country, timezone, tin, registration_number, contact_email,
                                 contact_phone, base_currency, settings)
       values ($1, $2, $3, $4, $5, $6, $7, $8::text,
               jsonb_build_object('currency', jsonb_build_object('enabledCurrencies', jsonb_build_array($8::text))))
       on conflict (singleton) do nothing`,
      [
        o.name,
        o.country,
        o.timezone,
        o.tin,
        o.registrationNumber,
        o.contactEmail,
        o.contactPhone,
        o.baseCurrency,
      ],
    );
    await tx.query(
      `insert into branches (code, name, is_default)
       select $1, $2, true where not exists (select 1 from branches where is_default)`,
      [input.defaultBranch.code, input.defaultBranch.name],
    );
    await this.syncCatalogue(input.catalogue);

    for (const [code, name] of EXPENSE_CATEGORIES) {
      await tx.query(
        "insert into expense_categories (code, name, is_system) values ($1, $2, true) on conflict (code) do nothing",
        [code, name],
      );
    }
    // Standard codes by country (decision 168), then placeholders.
    for (const code of standardTaxCodes(o.country, randomUUID)) {
      await tx.query(
        `insert into tax_codes (code, name, kind, applies_to, components, active)
         values ($1, $2, $3, $4, $5, $6) on conflict (code) do nothing`,
        [
          code.code,
          code.name,
          code.kind,
          code.appliesTo,
          JSON.stringify(code.components),
          code.active,
        ],
      );
    }
    for (const [code, name] of TAX_PLACEHOLDERS) {
      await tx.query(
        `insert into tax_codes (code, name, active, notes) values ($1, $2, false, $3)
         on conflict (code) do nothing`,
        [code, name, "Set the rate that applies to your business before activating"],
      );
    }

    const owner = await this.ensureOwner(tx, input.owner);
    await this.assertInvariants(tx, owner.id);
    return owner;
  }

  async syncCatalogue(catalogue: CatalogueSnapshot): Promise<CatalogueSyncResult> {
    const tx = this.transactions.current();
    const keys = catalogue.permissions.map((p) => p.key);
    const before = await tx.query<{ n: string }>(
      "select count(*) as n from permissions where not deprecated",
    );

    for (const p of catalogue.permissions) {
      await tx.query(
        `insert into permissions (key, module, description, scopes, sensitive, deprecated, catalogue_version)
         values ($1, $2, $3, $4, $5, false, $6)
         on conflict (key) do update set module = excluded.module, description = excluded.description,
           scopes = excluded.scopes, sensitive = excluded.sensitive, deprecated = false,
           catalogue_version = excluded.catalogue_version`,
        [p.key, p.module, p.description, [...p.scopes], p.sensitive, catalogue.version],
      );
    }
    const deprecated = await tx.query(
      "update permissions set deprecated = true where not (key = any($1)) and not deprecated",
      [keys],
    );

    const changedRoles: string[] = [];
    for (const template of catalogue.templates) {
      const { rows } = await tx.query<{ id: string }>(
        `insert into roles (name, description, is_system, system_key, locked)
         values ($1, $2, true, $3, true)
         on conflict (system_key) do update set name = excluded.name, description = excluded.description,
           updated_at = now()
         returning id`,
        [template.name, template.description, template.systemKey],
      );
      const roleId = rows[0]!.id;
      const wanted = template.grants.map((g) => `${g.key}:${g.scope}`).sort();
      const current = await tx.query<{ grant: string }>(
        "select permission_key || ':' || scope as grant from role_permissions where role_id = $1 order by 1",
        [roleId],
      );
      if (current.rows.map((r) => r.grant).join(",") === wanted.join(",")) continue;

      await tx.query("delete from role_permissions where role_id = $1", [roleId]);
      for (const grant of template.grants) {
        await tx.query(
          "insert into role_permissions (role_id, permission_key, scope) values ($1, $2, $3)",
          [roleId, grant.key, grant.scope],
        );
      }
      await tx.query(
        "update roles set perm_version = perm_version + 1, updated_at = now() where id = $1",
        [roleId],
      );
      // Holders must get new tokens carrying the new permissions.
      await tx.query(
        `update users set permission_version = permission_version + 1, updated_at = now()
          where id in (select user_id from user_roles where role_id = $1)`,
        [roleId],
      );
      changedRoles.push(template.systemKey);
    }

    await tx.query(
      "update organisation set catalogue_version = greatest(catalogue_version, $1), updated_at = now()",
      [catalogue.version],
    );
    const after = await tx.query<{ n: string }>(
      "select count(*) as n from permissions where not deprecated",
    );
    return {
      added: Math.max(Number(after.rows[0]?.n) - Number(before.rows[0]?.n), 0),
      deprecated: deprecated.rowCount ?? 0,
      changedRoles,
    };
  }

  async owner(): Promise<TenantOwner | null> {
    const { rows } = await this.transactions
      .current()
      .query<Owner>(
        "select id, name, email::text as email, phone, status from users where is_owner order by created_at limit 1",
      );
    return rows[0] ?? null;
  }

  private async ensureOwner(tx: Queryable, owner: SeedInput["owner"]): Promise<TenantOwner> {
    let { rows } = await tx.query<Owner>(
      "select id, name, email::text as email, phone, status from users where is_owner limit 1",
    );
    if (rows[0] === undefined) {
      ({ rows } = await tx.query<Owner>(
        `insert into users (email, phone, name, status, is_owner) values ($1, $2, $3, 'invited', true)
         returning id, name, email::text as email, phone, status`,
        [owner.email, owner.phone, owner.name],
      ));
    }
    const user = rows[0]!;
    await tx.query(
      `insert into user_roles (user_id, role_id, branch_id)
       select $1, id, null from roles where system_key = $2
       on conflict do nothing`,
      [user.id, OWNER_ROLE],
    );
    await tx.query(
      `insert into user_branches (user_id, branch_id)
       select $1, id from branches where is_default
       on conflict do nothing`,
      [user.id],
    );
    return user;
  }

  private async assertInvariants(tx: Queryable, ownerId: string): Promise<void> {
    const { rows } = await tx.query<{ owners: string; missing: string; has_role: boolean }>(
      `select (select count(*) from users where is_owner) as owners,
              (select count(*) from permissions p
                where not p.deprecated and p.key <> all($3::text[]) and not exists (
                  select 1 from role_permissions rp join roles r on r.id = rp.role_id
                   where r.system_key = $2 and rp.permission_key = p.key)) as missing,
              exists (select 1 from user_roles ur join roles r on r.id = ur.role_id
                       where ur.user_id = $1 and r.system_key = $2) as has_role`,
      [ownerId, OWNER_ROLE, SELF_SERVICE_PERMISSIONS],
    );
    const check = rows[0]!;
    if (Number(check.owners) !== 1)
      throw new Error(`Expected exactly one owner, found ${check.owners}`);
    if (Number(check.missing) !== 0)
      throw new Error(`Owner role misses ${check.missing} permission(s)`);
    if (!check.has_role) throw new Error("The owner does not hold the owner role");
  }
}
