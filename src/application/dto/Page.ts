/** A page of results with an opaque cursor for the next page (null on the last page). */
export type Page<T> = Readonly<{ items: T[]; nextCursor: string | null }>;
