import { describe, expect, it } from "vitest";
import { AuthorizationPolicy } from "./AuthorizationPolicy.js";
import { mergeGrants } from "./mergeGrants.js";
import { Principal } from "./Principal.js";

describe("mergeGrants", () => {
  it("narrows roles assigned for one branch to that branch", () => {
    const merged = mergeGrants([
      { key: "users.list", scope: "all", limits: null, assignmentBranchId: "kumasi" },
    ]);
    expect(merged.get("users.list")).toEqual({ scope: "branch", branchIds: ["kumasi"] });
  });

  it("combines branches and lets the widest scope win", () => {
    const merged = mergeGrants([
      { key: "users.view", scope: "branch", limits: null, assignmentBranchId: "kumasi" },
      { key: "users.view", scope: "branch", limits: null, assignmentBranchId: "accra" },
      { key: "users.list", scope: "branch", limits: null, assignmentBranchId: "kumasi" },
      { key: "users.list", scope: "all", limits: null, assignmentBranchId: null },
      { key: "users.update", scope: "branch", limits: null, assignmentBranchId: "kumasi" },
      { key: "users.update", scope: "branch", limits: null, assignmentBranchId: null },
    ]);
    expect(merged.get("users.view")).toEqual({ scope: "branch", branchIds: ["accra", "kumasi"] });
    expect(merged.get("users.list")).toEqual({ scope: "all" });
    expect(merged.get("users.update")).toEqual({ scope: "branch" });
  });

  it("keeps own scope and the most generous limits", () => {
    const merged = mergeGrants([
      { key: "x.y", scope: "own", limits: { max_percent: 5 }, assignmentBranchId: "kumasi" },
      {
        key: "x.y",
        scope: "own",
        limits: { max_percent: 10, max_amount: 100 },
        assignmentBranchId: null,
      },
    ]);
    expect(merged.get("x.y")).toEqual({
      scope: "own",
      limits: { max_percent: 10, max_amount: 100 },
    });
  });

  it("drives branch decisions in the policy", () => {
    const grants = mergeGrants([
      { key: "users.view", scope: "all", limits: null, assignmentBranchId: "kumasi" },
    ]);
    const principal = new Principal("u", "t", "s", {
      permissions: grants,
      branchIds: ["kumasi", "accra"],
    });
    const policy = new AuthorizationPolicy();
    expect(policy.decide(principal, "users.view", { branchId: "kumasi" }).allowed).toBe(true);
    expect(policy.decide(principal, "users.view", { branchId: "accra" }).allowed).toBe(false);
    expect(policy.branchesFor(principal, "users.view")).toEqual(["kumasi"]);
    expect(policy.branchesFor(principal, "users.list")).toEqual([]);
  });
});
