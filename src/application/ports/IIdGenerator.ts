/** New unique ids (time-ordered UUIDv7). */
export interface IIdGenerator {
  next(): string;
}
