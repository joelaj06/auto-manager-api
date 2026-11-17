import type { Page } from "../../application/dto/Page.js";

/** What a list response says about its page; CORS exposes them to browsers. */
export const PAGE_HEADERS = ["X-Total-Count", "X-Page", "X-Page-Size"] as const;

/**
 * The money totals a list of money gives in its headers, for the whole filtered list: its main
 * amount (`X-Total-Amount`), that amount in each status (`X-Total-<Status>`) and other amounts
 * its rows carry (`X-Total-Amount-<Measure>`), in minor units of `X-Currency`.
 */
export type ListTotalsSpec = Readonly<{
  /** What `X-Total-Amount` adds up; no header without it. */
  amount?: string;
  statuses: readonly string[];
  measures: Readonly<Record<string, string>>;
}>;

/** "partially_paid" → "Partially-Paid" */
const headerWord = (name: string) =>
  name
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1).toLowerCase())
    .join("-");

export const statusTotalHeader = (status: string) => `X-Total-${headerWord(status)}`;
export const measureTotalHeader = (measure: string) => `X-Total-Amount-${headerWord(measure)}`;

/** Declares a list's totals; refuses two totals that would share a header. */
export function listTotals(
  spec: Readonly<{
    amount?: string;
    statuses?: readonly string[];
    /** Each measure's name and what it adds up. */
    measures?: Readonly<Record<string, string>>;
  }>,
): ListTotalsSpec {
  const totals: ListTotalsSpec = {
    ...(spec.amount === undefined ? {} : { amount: spec.amount }),
    statuses: spec.amount === undefined ? [] : (spec.statuses ?? []),
    measures: spec.measures ?? {},
  };
  const names = totalsHeaderNames(totals).map((name) => name.toLowerCase());
  const taken = new Set(["x-total-count", ...PAGE_HEADERS.map((name) => name.toLowerCase())]);
  for (const name of names) {
    if (taken.has(name)) throw new Error(`Two list totals share the header ${name}`);
    taken.add(name);
  }
  return totals;
}

/** Every header a list's totals give, in order. */
export function totalsHeaderNames(spec: ListTotalsSpec): string[] {
  return [
    "X-Currency",
    ...(spec.amount === undefined ? [] : ["X-Total-Amount"]),
    ...spec.statuses.map(statusTotalHeader),
    ...Object.keys(spec.measures).map(measureTotalHeader),
  ];
}

export function pageHeaders(
  page: Omit<Page<unknown>, "items">,
  /** For a list of money: the totals it gives, every one present even when nothing adds up. */
  totals?: ListTotalsSpec,
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Total-Count": String(page.total),
    "X-Page": String(page.page),
    "X-Page-Size": String(page.pageSize),
  };
  if (totals === undefined) return headers;
  const sums = page.totals;
  if (sums === undefined) throw new Error("A list of money was paged without its totals");
  headers["X-Currency"] = sums.currency;
  if (totals.amount !== undefined) headers["X-Total-Amount"] = String(sums.amount);
  for (const status of totals.statuses)
    headers[statusTotalHeader(status)] = String(sums.byStatus[status] ?? 0);
  for (const measure of Object.keys(totals.measures))
    headers[measureTotalHeader(measure)] = String(sums.measures[measure] ?? 0);
  return headers;
}
