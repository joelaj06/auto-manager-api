import type { BranchInventory, IBranchContents } from "../../ports/IBranchContents.js";
import type { IBranchDeactivationCheck } from "../../ports/IBranches.js";

const OPEN_ITEMS: ReadonlyArray<readonly [keyof BranchInventory, string]> = [
  ["workpayAgreements", "open work and pay agreement"],
  ["openAssignments", "open vehicle assignment"],
  ["remittances", "unsettled remittance"],
  ["expenses", "unsettled expense"],
  ["recurringExpenses", "recurring expense"],
  ["invoices", "unpaid invoice"],
  ["vehicleIssues", "open vehicle issue"],
  ["openCashSessions", "open cash session"],
];

/**
 * Nothing live may be left in a branch no one can reach (docs/27 §3.5): open agreements,
 * unsettled remittances, expenses and invoices, recurring expenses, open issues and cash
 * sessions. The wizard moves them (cash sessions are closed); vehicles and drivers have their
 * own checks.
 */
export class OpenItemsBranchCheck implements IBranchDeactivationCheck {
  readonly name = "open_items";

  constructor(private readonly contents: IBranchContents) {}

  async check(branchId: string): Promise<string | null> {
    const inventory = await this.contents.inventory(branchId);
    const open = OPEN_ITEMS.filter(([key]) => inventory[key] > 0).map(
      ([key, label]) => `${inventory[key]} ${label}${inventory[key] === 1 ? "" : "s"}`,
    );
    if (open.length === 0) return null;
    return `${open.join(", ")} — move ${open.length === 1 && inventory.openCashSessions === 0 ? "it" : "them"} to another branch (close cash sessions) first`;
  }
}
