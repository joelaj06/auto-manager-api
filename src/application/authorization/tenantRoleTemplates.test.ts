import { describe, expect, it } from "vitest";
import { PERMISSION_CATALOG } from "./permissionCatalog.js";
import { OWNER_ROLE, TENANT_ROLE_TEMPLATES } from "./tenantRoleTemplates.js";

describe("tenant role templates", () => {
  it("use only catalogue permissions with allowed scopes, without duplicates", () => {
    for (const template of TENANT_ROLE_TEMPLATES) {
      const keys = template.grants.map((g) => g.key);
      expect(new Set(keys).size, template.systemKey).toBe(keys.length);
      for (const grant of template.grants) {
        expect(
          PERMISSION_CATALOG[grant.key].scopes,
          `${template.systemKey}: ${grant.key}`,
        ).toContain(grant.scope);
      }
    }
  });

  it("give the owner every permission at the widest scope and keep billing.manage owner-only", () => {
    const owner = TENANT_ROLE_TEMPLATES.find((t) => t.systemKey === OWNER_ROLE)!;
    expect(owner.grants.map((g) => g.key).sort()).toEqual(Object.keys(PERMISSION_CATALOG).sort());
    expect(owner.grants.every((g) => g.scope === "all")).toBe(true);
    const others = TENANT_ROLE_TEMPLATES.filter((t) => t.systemKey !== OWNER_ROLE);
    expect(others.some((t) => t.grants.some((g) => g.key === "billing.manage"))).toBe(false);
  });

  it("keep the auditor read-only", () => {
    const auditor = TENANT_ROLE_TEMPLATES.find((t) => t.systemKey === "auditor")!;
    expect(auditor.grants.every((g) => /\.(list|view)$/.test(g.key))).toBe(true);
  });
});
