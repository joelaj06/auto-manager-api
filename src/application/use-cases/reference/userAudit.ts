import type { AuditEntry } from "../../dto/AuditEntry.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";

/** Records a tenant user's change in the tenant audit trail (inside the unit of work). */
export async function recordUserAction(
  deps: Readonly<{ auditTrail: IAuditTrail; requestContext: IRequestContext }>,
  userId: string,
  entry: Omit<AuditEntry, "actorType" | "actorId" | "requestId" | "ip">,
): Promise<void> {
  const request = deps.requestContext.current();
  await deps.auditTrail.record({
    ...entry,
    actorType: "user",
    actorId: userId,
    requestId: request?.requestId ?? null,
    ip: request?.ip ?? null,
  });
}

/** A user's action, or the system's (null) when a rule or job acted. */
export async function recordAction(
  deps: Readonly<{ auditTrail: IAuditTrail; requestContext: IRequestContext }>,
  userId: string | null,
  entry: Omit<AuditEntry, "actorType" | "actorId" | "requestId" | "ip">,
): Promise<void> {
  if (userId !== null) return recordUserAction(deps, userId, entry);
  const request = deps.requestContext.current();
  await deps.auditTrail.record({
    ...entry,
    actorType: "system",
    actorId: null,
    requestId: request?.requestId ?? null,
    ip: request?.ip ?? null,
  });
}
