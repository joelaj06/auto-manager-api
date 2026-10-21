import { DocumentRuleError } from "../../../domain/documents/IssuedDocument.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { DocumentSettings, IDocumentSettingsStore } from "../../ports/IDocumentRecords.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { recordUserAction } from "../reference/userAudit.js";

/** Signing settings: codes, deadlines, reminders, link lifetime, typed signatures. */
export class DocumentSettingsService {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      settings: IDocumentSettingsStore;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
    }>,
  ) {}

  get(): Promise<DocumentSettings> {
    return this.deps.unitOfWork.run(() => this.deps.settings.get());
  }

  async update(actor: Principal, changes: Partial<DocumentSettings>): Promise<DocumentSettings> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await deps.settings.get();
      const after: DocumentSettings = {
        ...before,
        ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)),
      };
      const within = (value: number, min: number, max: number, what: string) => {
        if (!Number.isInteger(value) || value < min || value > max)
          throw new DocumentRuleError(`${what} is ${min} to ${max}`);
      };
      within(after.signingDays, 1, 365, "The signing deadline in days");
      within(after.reminderEveryDays, 1, 30, "Days between reminders");
      within(after.maxReminders, 0, 10, "The number of reminders");
      within(after.linkHours, 1, 720, "A signing link's lifetime in hours");
      await deps.settings.set(after);
      await recordUserAction(deps, actor.userId, {
        action: "settings.documents_updated",
        entityType: "organisation",
        before,
        after,
      });
      return after;
    });
  }
}
