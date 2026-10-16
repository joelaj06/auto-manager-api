export type BranchView = Readonly<{
  id: string;
  code: string;
  name: string;
  status: "active" | "inactive";
  isDefault: boolean;
  deactivatedAt: Date | null;
  createdAt: Date;
}>;

/** Branches of the current tenant (tenant unit of work). */
export interface IBranches {
  list(): Promise<BranchView[]>;
  lockById(id: string): Promise<BranchView | null>;
  setStatus(
    id: string,
    status: "active" | "inactive",
    reason: string | null,
    now: Date,
  ): Promise<void>;
  activeCount(): Promise<number>;
  create(input: {
    code: string;
    name: string;
    address: string | null;
    phone: string | null;
  }): Promise<string>;
  update(
    id: string,
    changes: { name?: string; address?: string | null; phone?: string | null },
  ): Promise<void>;
  makeDefault(id: string): Promise<void>;
  codeTaken(code: string): Promise<boolean>;
  existing(ids: readonly string[]): Promise<string[]>;
  /**
   * Members of the branch and holders of roles assigned to it get a new permission version, so
   * their next request re-evaluates what they may do.
   */
  invalidateMembers(branchId: string): Promise<number>;
}

/**
 * A module's veto on deactivating a branch (docs/27 §3.5: open rentals, cash sessions, …).
 * Returns a description of what must be resolved first, or null.
 */
export interface IBranchDeactivationCheck {
  readonly name: string;
  check(branchId: string): Promise<string | null>;
}
