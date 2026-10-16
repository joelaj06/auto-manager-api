import type { IKnownDevices } from "../../application/ports/IKnownDevices.js";
import type { PlatformDb } from "./PlatformDb.js";

export class PostgresKnownDevices implements IKnownDevices {
  constructor(private readonly db: PlatformDb) {}

  async remember(userId: string, deviceHash: string, now: Date): Promise<boolean> {
    const { rows } = await this.db.query<{ inserted: boolean }>(
      `insert into platform_known_devices (user_id, device_hash, first_seen_at, last_seen_at)
       values ($1, $2, $3, $3)
       on conflict (user_id, device_hash) do update set last_seen_at = excluded.last_seen_at
       returning (xmax = 0) as inserted`,
      [userId, deviceHash, now],
    );
    return rows[0]?.inserted === true;
  }
}
