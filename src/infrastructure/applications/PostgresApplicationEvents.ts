import type {
  ApplicationEvent,
  IApplicationEvents,
} from "../../application/ports/IApplicationEvents.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

type Row = {
  id: string;
  application_id: string;
  type: ApplicationEvent["type"];
  actor_type: ApplicationEvent["actorType"];
  actor_id: string | null;
  message: string | null;
  internal: boolean;
  details: Record<string, unknown>;
  created_at: Date;
};

export class PostgresApplicationEvents implements IApplicationEvents {
  constructor(private readonly db: PlatformDb) {}

  async append(event: Omit<ApplicationEvent, "id" | "createdAt">): Promise<void> {
    await this.db.query(
      `insert into tenant_application_events
         (application_id, type, actor_type, actor_id, message, internal, details)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        event.applicationId,
        event.type,
        event.actorType,
        event.actorId,
        event.message,
        event.internal,
        JSON.stringify(event.details),
      ],
    );
  }

  async list(applicationId: string, includeInternal: boolean): Promise<ApplicationEvent[]> {
    const { rows } = await this.db.query<Row>(
      `select * from tenant_application_events
        where application_id = $1 and ($2 or not internal)
        order by id`,
      [applicationId, includeInternal],
    );
    return rows.map((r) => ({
      id: r.id,
      applicationId: r.application_id,
      type: r.type,
      actorType: r.actor_type,
      actorId: r.actor_id,
      message: r.message,
      internal: r.internal,
      details: r.details,
      createdAt: r.created_at,
    }));
  }
}
