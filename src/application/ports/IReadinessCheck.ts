/** One dependency the API needs to serve traffic (database, cache, …). */
export interface IReadinessCheck {
  readonly name: string;
  /** Resolves when healthy; rejects (or times out) when not. */
  check(): Promise<void>;
}
