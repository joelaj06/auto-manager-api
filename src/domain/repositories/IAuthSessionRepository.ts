import type { AuthSession } from "../entities/AuthSession.js";

/** Sessions of the current tenant. Call inside a unit of work. */
export interface IAuthSessionRepository {
  findById(id: string): Promise<AuthSession | null>;
  /**
   * Loads the session and locks it until the unit of work ends, so concurrent refreshes of the
   * same session are serialised (the second one then sees a rotated-away token).
   */
  lockById(id: string): Promise<AuthSession | null>;
  /** Inserts or updates. */
  save(session: AuthSession): Promise<void>;
}
