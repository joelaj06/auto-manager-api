/**
 * Gap-free counters per key (1, 2, 3, …) within the current tenant. Must run inside a unit of
 * work: concurrent callers get distinct values, and a rolled-back unit of work gives its number
 * back.
 */
export interface ISequenceGenerator {
  next(key: string): Promise<number>;
}
