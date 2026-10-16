/** Current time; injected so time-dependent logic is testable. */
export interface IClock {
  now(): Date;
}
