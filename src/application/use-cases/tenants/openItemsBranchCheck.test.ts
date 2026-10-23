import { describe, expect, it } from "vitest";
import type { BranchInventory, IBranchContents } from "../../ports/IBranchContents.js";
import { OpenItemsBranchCheck } from "./OpenItemsBranchCheck.js";

const EMPTY: BranchInventory = {
  vehicles: 3,
  drivers: 2,
  users: 4,
  openAssignments: 0,
  workpayAgreements: 0,
  remittances: 0,
  expenses: 0,
  recurringExpenses: 0,
  invoices: 0,
  vehicleIssues: 0,
  openCashSessions: 0,
};

const check = (inventory: Partial<BranchInventory>) =>
  new OpenItemsBranchCheck({
    inventory: () => Promise.resolve({ ...EMPTY, ...inventory }),
  } as unknown as IBranchContents).check("b1");

describe("open items before deactivating a branch", () => {
  it("leaves vehicles, drivers and members to their own checks", async () => {
    expect(await check({})).toBeNull();
  });

  it("lists what is still open", async () => {
    expect(await check({ workpayAgreements: 1, remittances: 3, openCashSessions: 1 })).toBe(
      "1 open work and pay agreement, 3 unsettled remittances, 1 open cash session — move them to another branch (close cash sessions) first",
    );
    expect(await check({ invoices: 1 })).toMatch(/^1 unpaid invoice — move it/);
  });
});
