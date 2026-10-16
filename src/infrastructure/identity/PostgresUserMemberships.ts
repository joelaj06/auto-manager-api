import type {
  IUserMemberships,
  RoleAssignment,
  RoleAssignmentView,
} from "../../application/ports/IUserMemberships.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

export class PostgresUserMemberships implements IUserMemberships {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async branchesOf(userId: string): Promise<string[]> {
    const { rows } = await this.transactions
      .current()
      .query<{ branch_id: string }>(
        "select branch_id from user_branches where user_id = $1 order by branch_id",
        [userId],
      );
    return rows.map((r) => r.branch_id);
  }

  async setBranches(userId: string, branchIds: readonly string[]): Promise<void> {
    const tx = this.transactions.current();
    await tx.query(
      "delete from user_branches where user_id = $1 and not (branch_id = any($2::uuid[]))",
      [userId, branchIds],
    );
    await tx.query(
      `insert into user_branches (user_id, branch_id) select $1, unnest($2::uuid[])
       on conflict do nothing`,
      [userId, branchIds],
    );
  }

  async assignmentsOf(userId: string): Promise<RoleAssignmentView[]> {
    const { rows } = await this.transactions.current().query<{
      role_id: string;
      branch_id: string | null;
      name: string;
      system_key: string | null;
    }>(
      `select ur.role_id, ur.branch_id, r.name, r.system_key
         from user_roles ur join roles r on r.id = ur.role_id and r.deleted_at is null
        where ur.user_id = $1 order by r.name, ur.branch_id nulls first`,
      [userId],
    );
    return rows.map((r) => ({
      roleId: r.role_id,
      branchId: r.branch_id,
      roleName: r.name,
      systemKey: r.system_key,
    }));
  }

  async setAssignments(
    userId: string,
    assignments: readonly RoleAssignment[],
    assignedBy: string,
  ): Promise<void> {
    const tx = this.transactions.current();
    await tx.query("delete from user_roles where user_id = $1", [userId]);
    for (const a of assignments) {
      await tx.query(
        `insert into user_roles (user_id, role_id, branch_id, assigned_by) values ($1, $2, $3, $4)
         on conflict do nothing`,
        [userId, a.roleId, a.branchId, assignedBy],
      );
    }
  }

  async holdersOf(roleId: string): Promise<string[]> {
    const { rows } = await this.transactions
      .current()
      .query<{ user_id: string }>("select distinct user_id from user_roles where role_id = $1", [
        roleId,
      ]);
    return rows.map((r) => r.user_id);
  }
}
