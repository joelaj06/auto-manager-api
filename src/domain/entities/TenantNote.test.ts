import { describe, expect, it } from "vitest";
import { InvalidTagError, MAX_TAGS_PER_TENANT, TenantTag } from "../value-objects/TenantTag.js";
import { InvalidNoteError, NoteNotYoursError, TenantNote } from "./TenantNote.js";

const now = new Date("2026-10-16T10:00:00Z");
const note = () =>
  TenantNote.write({
    id: "n1",
    tenantId: "t1",
    body: "  Called owner  ",
    pinned: false,
    authorId: "a",
    now,
  });

describe("TenantNote", () => {
  it("trims the body and refuses empty or oversized notes", () => {
    expect(note().toSnapshot().body).toBe("Called owner");
    expect(() =>
      TenantNote.write({ id: "n", tenantId: "t", body: "  ", pinned: false, authorId: "a", now }),
    ).toThrow(InvalidNoteError);
    expect(() =>
      TenantNote.write({
        id: "n",
        tenantId: "t",
        body: "x".repeat(5_001),
        pinned: false,
        authorId: "a",
        now,
      }),
    ).toThrow(InvalidNoteError);
  });

  it("lets only the author edit or delete, anyone pin", () => {
    const n = note();
    expect(() => n.edit("changed", "b", now)).toThrow(NoteNotYoursError);
    expect(() => n.delete("b", now)).toThrow(NoteNotYoursError);
    n.pin(true, now);
    n.edit("changed", "a", now);
    expect(n.toSnapshot()).toMatchObject({ body: "changed", pinned: true });
    n.delete("a", now);
    expect(n.deleted).toBe(true);
  });
});

describe("TenantTag", () => {
  it("normalises tags", () => {
    expect(TenantTag.from("  At Risk ").value).toBe("at-risk");
    expect(TenantTag.set(["VIP", "vip", "at-risk"])).toEqual(["at-risk", "vip"]);
  });

  it("refuses invalid tags and too many tags", () => {
    for (const bad of ["", "-vip", "vip-", "v!p", "x".repeat(31)])
      expect(() => TenantTag.from(bad)).toThrow(InvalidTagError);
    const many = Array.from({ length: MAX_TAGS_PER_TENANT + 1 }, (_, i) => `t${i}`);
    expect(() => TenantTag.set(many)).toThrow(InvalidTagError);
  });
});
