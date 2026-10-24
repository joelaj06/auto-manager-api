import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import type { IPlatformAuditTrail, PlatformAuditEntry } from "../../ports/IPlatformAuditTrail.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";

/** Records a staff action in the platform audit log with the current request's id and IP. */
export async function recordStaffAction(
  deps: Readonly<{ audit: IPlatformAuditTrail; requestContext: IRequestContext }>,
  actor: Pick<PlatformPrincipal, "userId">,
  entry: Omit<PlatformAuditEntry, "actorType" | "actorId" | "requestId" | "ip">,
): Promise<void> {
  const request = deps.requestContext.current();
  await deps.audit.record({
    ...entry,
    actorType: "platform_staff",
    actorId: actor.userId,
    requestId: request?.requestId ?? null,
    ip: request?.ip ?? null,
  });
}
