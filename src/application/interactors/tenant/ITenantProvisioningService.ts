import { ITenant } from "../../../entities";

export interface ITenantProvisioningService {
  provision(
    tenant: ITenant,
    adminUser: AdminUserInput,
  ): Promise<ProvisioningResult>;
}

export interface AdminUserInput {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  phone?: string;
}

export interface ProvisioningResult {
  tenant: ITenant;
  tenantUrl: string;
}
