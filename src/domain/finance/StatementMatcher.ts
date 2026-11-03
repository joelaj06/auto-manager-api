const DAY_MS = 86_400_000;
/** A reference found on the statement holds across this many days, as bank clearing can take. */
export const REFERENCE_DAYS = 14;
/** The amount alone holds only this close, and only when nothing else could be meant. */
export const AMOUNT_DAYS = 3;
const MIN_TOKEN = 4;
const MAX_SUGGESTIONS = 5;

export type MatchableLine = Readonly<{
  id: string;
  date: string;
  amountMinor: number;
  description: string;
  reference: string | null;
}>;

/** An unmatched ledger line of the account; a positive amount is money in. */
export type MatchCandidate = Readonly<{
  ledgerLineId: string;
  date: string;
  amountMinor: number;
  /** The journal number, the payment's number and its bank or MoMo reference. */
  references: readonly (string | null)[];
  /** Reversed, or a reversal: normally never reached the bank, so never matched by itself. */
  cancelled: boolean;
}>;

export type AutoMatch = Readonly<{
  statementLineId: string;
  ledgerLineId: string;
  by: "reference" | "amount_and_date";
}>;

const plain = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, "");
const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY_MS;

function referenceFound(line: MatchableLine, candidate: MatchCandidate): boolean {
  const statement = plain(`${line.reference ?? ""} ${line.description}`);
  return candidate.references.some((reference) => {
    const token = plain(reference ?? "");
    return token.length >= MIN_TOKEN && statement.includes(token);
  });
}

const within = (line: MatchableLine, candidate: MatchCandidate, days: number) =>
  candidate.amountMinor === line.amountMinor &&
  !candidate.cancelled &&
  daysApart(line.date, candidate.date) <= days;

/**
 * Automatic matching (docs/13 §4, decision 513): the same amount with a reference found on the
 * statement within 14 days, then the same amount within 3 days when exactly one ledger line and
 * one statement line could be meant. Anything ambiguous is left for a person.
 */
export function autoMatch(
  lines: readonly MatchableLine[],
  candidates: readonly MatchCandidate[],
): AutoMatch[] {
  const matches: AutoMatch[] = [];
  const open = new Map(candidates.map((c) => [c.ledgerLineId, c]));
  const left = new Map(lines.map((l) => [l.id, l]));
  const take = (line: MatchableLine, candidate: MatchCandidate, by: AutoMatch["by"]) => {
    matches.push({ statementLineId: line.id, ledgerLineId: candidate.ledgerLineId, by });
    open.delete(candidate.ledgerLineId);
    left.delete(line.id);
  };

  for (const line of lines) {
    const hits = [...open.values()].filter(
      (c) => within(line, c, REFERENCE_DAYS) && referenceFound(line, c),
    );
    if (hits.length === 1) take(line, hits[0]!, "reference");
  }
  const remaining = [...left.values()];
  for (const line of remaining) {
    const near = [...open.values()].filter((c) => within(line, c, AMOUNT_DAYS));
    if (near.length !== 1) continue;
    const rivals = remaining.filter((l) => left.has(l.id) && within(l, near[0]!, AMOUNT_DAYS));
    if (rivals.length === 1) take(line, near[0]!, "amount_and_date");
  }
  return matches;
}

/** The likeliest ledger lines for a statement line: references first, then the nearest dates. */
export function suggestions(
  line: MatchableLine,
  candidates: readonly MatchCandidate[],
): MatchCandidate[] {
  return candidates
    .filter((c) => within(line, c, REFERENCE_DAYS))
    .map((c) => ({ c, hit: referenceFound(line, c), days: daysApart(line.date, c.date) }))
    .sort((a, b) => Number(b.hit) - Number(a.hit) || a.days - b.days)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ c }) => c);
}
