import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import type {
  IPlatformAuditTrail,
  PlatformAuditQuery,
  PlatformAuditRecord,
} from "../../ports/IPlatformAuditTrail.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import { recordStaffAction } from "./consoleAudit.js";

/** At most this many entries per export; narrow the filters for more. */
export const AUDIT_EXPORT_LIMIT = 10_000;
const PAGE = 500;

export type AuditExport = Readonly<{ entries: PlatformAuditRecord[]; truncated: boolean }>;

/** Exports the platform audit log (docs/27 §3.15). The export itself is audited. */
export class AuditLogExport {
  constructor(
    private readonly deps: Readonly<{
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
    }>,
  ) {}

  async export(
    filter: Omit<PlatformAuditQuery, "limit" | "before">,
    actor: PlatformPrincipal,
  ): Promise<AuditExport> {
    const entries: PlatformAuditRecord[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.deps.audit.search({ ...filter, limit: PAGE, before });
      entries.push(...page);
      if (page.length < PAGE || entries.length > AUDIT_EXPORT_LIMIT) break;
      before = page.at(-1)?.id;
    }
    const truncated = entries.length > AUDIT_EXPORT_LIMIT;
    const exported = entries.slice(0, AUDIT_EXPORT_LIMIT);
    await recordStaffAction(this.deps, actor, {
      action: "audit.exported",
      entityType: "platform_audit_log",
      metadata: {
        filter: JSON.parse(JSON.stringify(filter)) as unknown,
        rows: exported.length,
        truncated,
      },
    });
    return { entries: exported, truncated };
  }
}
