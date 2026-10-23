/** What is still live in a branch (docs/27 §3.5): the deactivation wizard's checklist. */
export type BranchInventory = Readonly<{
  vehicles: number;
  drivers: number;
  users: number;
  openAssignments: number;
  workpayAgreements: number;
  remittances: number;
  expenses: number;
  recurringExpenses: number;
  invoices: number;
  vehicleIssues: number;
  /** Cannot be moved: close them first. */
  openCashSessions: number;
}>;

export type BranchMove = Omit<BranchInventory, "openCashSessions"> &
  Readonly<{ customers: number; roleAssignments: number }>;

/** Live records of a branch and moving them to another (tenant unit of work). */
export interface IBranchContents {
  inventory(branchId: string): Promise<BranchInventory>;
  /**
   * Moves every live record (vehicles with their open assignments, active drivers, open work and
   * pay agreements, unsettled remittances, expenses and invoices, recurring expenses, open
   * vehicle issues, customers' home branch, and — with `users` — memberships and branch roles)
   * from one branch to another. History stays where it happened.
   */
  moveLive(from: string, to: string, options: Readonly<{ users: boolean }>): Promise<BranchMove>;
  /** Tables that still hold records of the branch (memberships and branch roles aside). */
  tablesWithRecords(branchId: string): Promise<string[]>;
  /** Deletes a branch that holds no records, with its memberships and branch roles. */
  remove(branchId: string): Promise<void>;
}
