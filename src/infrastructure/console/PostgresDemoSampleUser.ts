import { randomBytes } from "node:crypto";
import { OWNER_ROLE } from "../../application/authorization/tenantRoleTemplates.js";
import type { IDemoSampleUser } from "../../application/ports/IDemoTenants.js";
import type { IPasswordHasher } from "../../application/ports/IPasswordHasher.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const EMAIL = "sample-data@demo.autoforce.invalid";

/** The demo's sample-data user in the tenant database (decision 501). */
export class PostgresDemoSampleUser implements IDemoSampleUser {
  constructor(
    private readonly transactions: PostgresTransactionContext,
    private readonly hasher: IPasswordHasher,
  ) {}

  async open(): Promise<Readonly<{ id: string; permissionVersion: number }>> {
    const tx = this.transactions.current();
    // A password nobody is told: the user exists only to enter the sample data.
    const hash = await this.hasher.hash(randomBytes(32).toString("base64url"));
    const { rows } = await tx.query<{ id: string; permission_version: number }>(
      `insert into users (email, name, status, password_hash)
       values ($1, 'Autoforce sample data', 'active', $2)
       on conflict (email) do update
         set status = 'active', password_hash = excluded.password_hash
       returning id, permission_version`,
      [EMAIL, hash],
    );
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
    return { id: user.id, permissionVersion: user.permission_version };
  }

  async close(userId: string): Promise<void> {
    await this.transactions.current().query(
      `update users set status = 'disabled', password_hash = null,
                permission_version = permission_version + 1
          where id = $1`,
      [userId],
    );
  }
}
