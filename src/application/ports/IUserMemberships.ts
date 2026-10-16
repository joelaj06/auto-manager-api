export type RoleAssignment = Readonly<{ roleId: string; branchId: string | null }>;

export type RoleAssignmentView = RoleAssignment &
  Readonly<{ roleName: string; systemKey: string | null }>;

/** Which branches a user belongs to and which roles they hold where (tenant unit of work). */
export interface IUserMemberships {
  branchesOf(userId: string): Promise<string[]>;
  setBranches(userId: string, branchIds: readonly string[]): Promise<void>;
  assignmentsOf(userId: string): Promise<RoleAssignmentView[]>;
  setAssignments(
    userId: string,
    assignments: readonly RoleAssignment[],
    assignedBy: string,
  ): Promise<void>;
  /** Users holding the role (to invalidate their tokens after a role edit). */
  holdersOf(roleId: string): Promise<string[]>;
}
