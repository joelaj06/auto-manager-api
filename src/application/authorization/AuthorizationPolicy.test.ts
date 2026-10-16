import { describe, expect, it } from "vitest";
import { PermissionDeniedError } from "../errors/AuthErrors.js";
import { AuthorizationPolicy } from "./AuthorizationPolicy.js";
import { isPermissionKey, PERMISSION_CATALOG } from "./permissionCatalog.js";
import { Principal, type PermissionGrant } from "./Principal.js";

const policy = new AuthorizationPolicy();
const principal = (permissions: Record<string, PermissionGrant>, branchIds: string[] = []) =>
  new Principal("user-1", "tenant-1", "session-1", {
    permissions: new Map(Object.entries(permissions)),
    branchIds,
  });

describe("AuthorizationPolicy", () => {
  it("denies without a grant", () => {
    expect(policy.decide(principal({}), "users.list")).toEqual({ allowed: false });
    expect(() => policy.require(principal({}), "users.list")).toThrow(PermissionDeniedError);
  });

  it("returns the scope for collection actions so callers can filter", () => {
    const p = principal({ "users.list": { scope: "branch" } }, ["b1"]);
    expect(policy.decide(p, "users.list")).toEqual({ allowed: true, scope: "branch" });
  });

  it("allows any record with an all-scope grant", () => {
    const p = principal({ "users.view": { scope: "all" } });
    expect(policy.decide(p, "users.view", { branchId: "elsewhere" }).allowed).toBe(true);
  });

  it("limits branch-scoped grants to the user's branches", () => {
    const p = principal({ "users.view": { scope: "branch" } }, ["kumasi", "accra"]);
    expect(policy.decide(p, "users.view", { branchId: "accra" }).allowed).toBe(true);
    expect(policy.decide(p, "users.view", { branchId: "tema" }).allowed).toBe(false);
    expect(policy.decide(p, "users.view", { branchId: null }).allowed).toBe(false);
  });

  it("limits own-scoped grants to the user's records", () => {
    const p = principal({ "users.view": { scope: "own" } });
    expect(policy.decide(p, "users.view", { ownerId: "user-1" }).allowed).toBe(true);
    expect(policy.decide(p, "users.view", { ownerId: "user-2" }).allowed).toBe(false);
    expect(policy.decide(p, "users.view", {}).allowed).toBe(false);
  });

  it("exposes numeric limits", () => {
    const p = principal({ "users.update": { scope: "all", limits: { max_percent: 10 } } });
    expect(policy.limit(p, "users.update", "max_percent")).toBe(10);
    expect(policy.limit(p, "users.update", "other")).toBeUndefined();
    expect(policy.limit(p, "users.list", "max_percent")).toBeUndefined();
  });
});

describe("permission catalogue", () => {
  const keys = Object.keys(PERMISSION_CATALOG);

  it("uses well-formed keys", () => {
    for (const key of keys) {
      expect(key, key).toMatch(/^[a-z][a-z_]*(\.[a-z][a-z_]*){1,2}$/);
    }
  });

  it("gives every permission a description and at least one scope", () => {
    for (const [key, definition] of Object.entries(PERMISSION_CATALOG)) {
      expect(definition.description.length, key).toBeGreaterThan(0);
      expect(definition.scopes.length, key).toBeGreaterThan(0);
    }
  });

  it("recognises catalogue keys only", () => {
    expect(isPermissionKey("users.list")).toBe(true);
    expect(isPermissionKey("users.fly")).toBe(false);
    expect(isPermissionKey("toString")).toBe(false);
  });
});
