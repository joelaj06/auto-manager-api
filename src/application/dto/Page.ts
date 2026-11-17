import type { ListSums, Paged, PageWindow, Summed } from "../../domain/value-objects/Paged.js";

/** The page a client asked for, numbered from 1. */
export type PageRequest = Readonly<{ page: number; pageSize: number }>;

/** The money of a whole list, in minor units of `currency` (the business's base currency). */
export type ListTotals = ListSums & Readonly<{ currency: string }>;

/**
 * A page of a list, with the whole list's size so a client can jump to any page, and for a list
 * of money its totals.
 */
export type Page<T> = Readonly<{
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totals?: ListTotals;
}>;

/** A list's filter as a client gives it: a page instead of a window. */
export type Paging<F> = Omit<F, "limit" | "offset"> & PageRequest;

export function pageWindow({ page, pageSize }: PageRequest): Required<PageWindow> {
  return { limit: pageSize, offset: (page - 1) * pageSize };
}

export function pageOf<T>(request: PageRequest, paged: Paged<T>): Page<T>;
export function pageOf<T, U>(request: PageRequest, paged: Paged<T>, view: (row: T) => U): Page<U>;
export function pageOf<T, U>(
  { page, pageSize }: PageRequest,
  { rows, total }: Paged<T>,
  view?: (row: T) => U,
): Page<T | U> {
  return { items: view === undefined ? rows : rows.map(view), total, page, pageSize };
}

/** A page of rows already in hand, for a list worked out in memory. */
export function slicePage<T>(request: PageRequest, rows: readonly T[]): Page<T> {
  const { limit, offset } = pageWindow(request);
  return pageOf(request, { rows: rows.slice(offset, offset + limit), total: rows.length });
}

/** A page of a list of money, with the whole list's totals in `currency`. */
export function summedPageOf<T>(request: PageRequest, summed: Summed<T>, currency: string): Page<T>;
export function summedPageOf<T, U>(
  request: PageRequest,
  summed: Summed<T>,
  currency: string,
  view: (row: T) => U,
): Page<U>;
export function summedPageOf<T, U>(
  request: PageRequest,
  summed: Summed<T>,
  currency: string,
  view?: (row: T) => U,
): Page<T | U> {
  const page = view === undefined ? pageOf(request, summed) : pageOf(request, summed, view);
  return { ...page, totals: { ...summed.sums, currency } };
}
