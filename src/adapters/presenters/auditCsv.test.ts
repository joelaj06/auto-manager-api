import { describe, expect, it } from "vitest";
import { auditCsv } from "./auditCsv.js";

describe("auditCsv", () => {
  it("quotes, escapes and neutralises formulas", () => {
    const csv = auditCsv([
      {
        id: "1",
        occurredAt: new Date("2026-10-16T10:00:00Z"),
        actorType: "platform_staff",
        actorId: "a",
        action: "tenant.note_added",
        entityType: "tenant_note",
        reason: '=HYPERLINK("x"), "quoted"',
        after: { body: "line\nbreak" },
      },
    ]);
    const [header, row] = csv.split("\r\n");
    expect(header).toBe(
      "occurredAt,id,actorType,actorId,action,entityType,entityId,targetTenantId,reason,requestId,ip,before,after,metadata",
    );
    expect(row).toContain("2026-10-16T10:00:00.000Z,1,platform_staff,a,tenant.note_added");
    expect(row).toContain(`"'=HYPERLINK(""x""), ""quoted"""`);
    expect(csv).toContain(`"{""body"":""line\\nbreak""}"`);
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});
