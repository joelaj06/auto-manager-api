export type Attempt<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: unknown }>;

/**
 * Runs `work` atomically against the platform database: platform repositories used inside it
 * commit or roll back together. Nested calls join the outer unit of work. Independent of the
 * tenant unit of work (never shares its transaction).
 */
export interface IPlatformUnitOfWork {
  run<T>(work: () => Promise<T>): Promise<T>;
  /**
   * Inside `run`: executes `work` behind a savepoint. If it throws, only its own changes are
   * undone and the error is returned, so the caller can record the failure and still commit.
   */
  attempt<T>(work: () => Promise<T>): Promise<Attempt<T>>;
}
