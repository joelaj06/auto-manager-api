/** Which rows of a list to read: `limit` rows after skipping `offset`. */
export type PageWindow = Readonly<{ limit: number; offset?: number }>;

/** One window of a list, with how many rows the whole list has. */
export type Paged<T> = Readonly<{ rows: T[]; total: number }>;
