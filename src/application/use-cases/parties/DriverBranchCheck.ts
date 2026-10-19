import type { IBranchDeactivationCheck } from "../../ports/IBranches.js";
import type { IDriverQueries } from "../../ports/IPartyRecords.js";

/** A branch is deactivated only once its drivers are moved or terminated (docs/27 §3.5). */
export class DriverBranchCheck implements IBranchDeactivationCheck {
  readonly name = "drivers";

  constructor(private readonly queries: IDriverQueries) {}

  async check(branchId: string): Promise<string | null> {
    const count = await this.queries.countInBranch(branchId);
    if (count === 0) return null;
    return `${count} driver${count === 1 ? " is" : "s are"} still in this branch — move or terminate them first`;
  }
}
