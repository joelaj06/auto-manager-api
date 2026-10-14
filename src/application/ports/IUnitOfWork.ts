/**
 * Runs `work` atomically against the current tenant's database: everything repositories do
 * inside it commits together or rolls back together. Nested calls join the outer unit of work.
 */
export interface IUnitOfWork {
  run<T>(work: () => Promise<T>): Promise<T>;
}
