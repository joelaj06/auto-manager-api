import type { IClock } from "../../application/ports/IClock.js";

export class SystemClock implements IClock {
  now(): Date {
    return new Date();
  }
}
