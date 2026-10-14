import type pg from "pg";
import type { IReadinessCheck } from "../../application/ports/IReadinessCheck.js";

/** Ready when the platform database answers a trivial query. */
export class DatabaseReadinessCheck implements IReadinessCheck {
  readonly name = "database";

  constructor(private readonly pool: pg.Pool) {}

  async check(): Promise<void> {
    await this.pool.query("select 1");
  }
}
