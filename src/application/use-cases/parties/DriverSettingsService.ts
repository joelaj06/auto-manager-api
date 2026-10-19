import type { DriverOnboardingRules } from "../../../domain/parties/Driver.js";
import { InvalidPartyError } from "../../../domain/parties/PartyDetails.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IDriverSettingsStore } from "../../ports/IPartyRecords.js";
import { PARTY_DOCUMENT_TYPES } from "../../ports/IPartyRecords.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { recordUserAction } from "../reference/userAudit.js";

/** What the business requires before a driver can start (the onboarding checklist). */
export class DriverSettingsService {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      settings: IDriverSettingsStore;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
    }>,
  ) {}

  get(): Promise<DriverOnboardingRules> {
    return this.deps.unitOfWork.run(() => this.deps.settings.get());
  }

  async update(
    actor: Principal,
    changes: Partial<DriverOnboardingRules>,
  ): Promise<DriverOnboardingRules> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await deps.settings.get();
      const after: DriverOnboardingRules = {
        ...before,
        ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)),
      };
      if (after.requiredGuarantors < 0 || after.requiredGuarantors > 5)
        throw new InvalidPartyError("Require 0 to 5 guarantors");
      if (
        after.requiredDocuments.some(
          (t) => !(PARTY_DOCUMENT_TYPES as readonly string[]).includes(t),
        )
      )
        throw new InvalidPartyError("Unknown document type");
      await deps.settings.set({
        ...after,
        requiredDocuments: [...new Set(after.requiredDocuments)],
      });
      await recordUserAction(deps, actor.userId, {
        action: "settings.drivers_updated",
        entityType: "organisation",
        before,
        after,
      });
      return deps.settings.get();
    });
  }
}
