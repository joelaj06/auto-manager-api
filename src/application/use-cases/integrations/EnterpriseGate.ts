import { EnterpriseLicenceRequiredError } from "../../errors/IntegrationErrors.js";
import type { ITenantLicence } from "../../ports/ITenantLicence.js";

/** Enterprise extras need the Enterprise licence on the subscription (decision 523). */
export class EnterpriseGate {
  constructor(private readonly licence: ITenantLicence) {}

  async allows(tenantId: string): Promise<boolean> {
    return (await this.licence.licenceType(tenantId)) === "enterprise";
  }

  async require(tenantId: string): Promise<void> {
    if (!(await this.allows(tenantId))) throw new EnterpriseLicenceRequiredError();
  }
}
