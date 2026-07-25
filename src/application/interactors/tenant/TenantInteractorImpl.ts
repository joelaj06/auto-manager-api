import { inject, injectable } from "inversify";
import { ITenant, PaginatedResponse, RequestQuery } from "../../../entities";
import { ITenantRepository } from "../../../frameworks";
import { INTERFACE_TYPE } from "../../../utils/constants";
import { ITenantInteractor } from "./ITenantInteractor";
import {
  NotFoundError,
  UnprocessableEntityError,
} from "../../../error_handler";
import { ConflictError } from "../../../error_handler/ConflictError";
import {
  AdminUserInput,
  ITenantProvisioningService,
} from "./ITenantProvisioningService";

@injectable()
export class TenantInteractorImpl implements ITenantInteractor {
  private repository: ITenantRepository;

  constructor(
    @inject(INTERFACE_TYPE.TenantRepositoryImpl) repository: ITenantRepository,
    @inject(INTERFACE_TYPE.TenantProvisioningServiceImpl)
    private provisioningService: ITenantProvisioningService,
  ) {
    this.repository = repository;
  }

  async createTenant(
    data: Partial<ITenant> & { adminUser: AdminUserInput },
  ): Promise<ITenant> {
    if (!data.name || !data.slug)
      throw new UnprocessableEntityError("Tenant name and slug are required");
    if (!data.adminUser?.email || !data.adminUser?.password)
      throw new UnprocessableEntityError(
        "Admin user email and password are required",
      );

    const existing = await this.repository.findTenantBySlug(data.slug);
    if (existing) throw new ConflictError("Tenant slug already in use");

    const tenant = await this.repository.createTenant(data);
    const { tenant: provisionedTenant } =
      await this.provisioningService.provision(tenant, data.adminUser);
    return provisionedTenant;
  }

  async getAllTenants(
    query: RequestQuery,
  ): Promise<PaginatedResponse<ITenant>> {
    return this.repository.findAllTenants(query);
  }

  async getTenant(id: string): Promise<ITenant> {
    if (!id) throw new UnprocessableEntityError("Tenant id is required");
    const tenant = await this.repository.findTenantById(id);
    if (!tenant) throw new NotFoundError("Tenant not found");
    return tenant;
  }

  async updateTenant(id: string, data: Partial<ITenant>): Promise<ITenant> {
    await this.getTenant(id); // 404s if missing
    return this.repository.updateTenant(id, data);
  }

  async deleteTenant(id: string): Promise<void> {
    await this.getTenant(id);
    return this.repository.softDeleteTenant(id);
  }

  async activateTenant(id: string): Promise<ITenant> {
    await this.getTenant(id);
    return this.repository.updateTenant(id, { status: "active" } as any);
  }

  async deactivateTenant(id: string): Promise<ITenant> {
    await this.getTenant(id);
    return this.repository.updateTenant(id, { status: "inactive" } as any);
  }

  async suspendTenant(id: string): Promise<ITenant> {
    await this.getTenant(id);
    return this.repository.updateTenant(id, { status: "suspended" } as any);
  }

  async renewSubscription(id: string, expiresAt: Date): Promise<ITenant> {
    if (!expiresAt)
      throw new UnprocessableEntityError("Expiry date is required");
    await this.getTenant(id);
    return this.repository.updateTenant(id, {
      subscriptionStatus: "active",
      subscriptionExpiresAt: expiresAt,
    } as any);
  }
}
