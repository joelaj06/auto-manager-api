import { describe, expect, it } from "vitest";
import {
  autoMatch,
  suggestions,
  type MatchableLine,
  type MatchCandidate,
} from "./StatementMatcher.js";

const line = (id: string, over: Partial<MatchableLine> = {}): MatchableLine => ({
  id,
  date: "2026-10-10",
  amountMinor: 10_000,
  description: "Transfer",
  reference: null,
  ...over,
});
const ledger = (id: string, over: Partial<MatchCandidate> = {}): MatchCandidate => ({
  ledgerLineId: id,
  date: "2026-10-10",
  amountMinor: 10_000,
  references: [`JRN-${id}`, null, null],
  cancelled: false,
  ...over,
});

describe("autoMatch", () => {
  it("matches a reference found on the statement, even with others of the amount about", () => {
    const matches = autoMatch(
      [line("a", { description: "MOMO 7788-1234 Ama", date: "2026-10-18" })],
      [ledger("1"), ledger("2", { references: ["JRN-2", "RCT-5", "77881234"] })],
    );
    expect(matches).toEqual([{ statementLineId: "a", ledgerLineId: "2", by: "reference" }]);
  });

  it("ignores a reference too short to mean anything or outside two weeks", () => {
    expect(
      autoMatch(
        [line("a", { description: "A1 paid" })],
        [ledger("1", { references: ["A1"] }), ledger("2")],
      ),
    ).toEqual([]);
    expect(
      autoMatch(
        [line("a", { reference: "RCT-5", date: "2026-10-30" })],
        [ledger("1", { references: ["RCT-5"] })],
      ),
    ).toEqual([]);
  });

  it("matches on amount and date only when nothing else could be meant", () => {
    expect(autoMatch([line("a")], [ledger("1", { date: "2026-10-12" })])).toEqual([
      { statementLineId: "a", ledgerLineId: "1", by: "amount_and_date" },
    ]);
    expect(autoMatch([line("a")], [ledger("1"), ledger("2")])).toEqual([]);
    expect(autoMatch([line("a"), line("b")], [ledger("1")])).toEqual([]);
    expect(autoMatch([line("a")], [ledger("1", { date: "2026-10-14" })])).toEqual([]);
    expect(autoMatch([line("a")], [ledger("1", { amountMinor: -10_000 })])).toEqual([]);
  });

  it("uses a ledger line once and never a reversed one", () => {
    const matches = autoMatch(
      [line("a", { reference: "RCT-5" }), line("b", { reference: "RCT-5" })],
      [ledger("1", { references: ["RCT-5"] })],
    );
    expect(matches).toHaveLength(1);
    expect(autoMatch([line("a")], [ledger("1", { cancelled: true })])).toEqual([]);
  });
});

describe("suggestions", () => {
  it("puts references first, then the nearest date, at most five", () => {
    const found = suggestions(line("a", { reference: "RCT-5" }), [
      ledger("far", { date: "2026-10-20" }),
      ledger("near", { date: "2026-10-11" }),
      ledger("ref", { date: "2026-10-21", references: ["RCT-5"] }),
      ...["3", "4", "5", "6"].map((id) => ledger(id, { date: "2026-10-22" })),
    ]);
    expect(found).toHaveLength(5);
    expect(found.slice(0, 3).map((c) => c.ledgerLineId)).toEqual(["ref", "near", "far"]);
  });
});
