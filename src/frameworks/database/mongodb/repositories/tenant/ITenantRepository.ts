import { PaginatedResponse, RequestQuery } from "../../../../../entities";
import { ITenant } from "../../../../../entities/Tenant";

export interface ITenantRepository {
  findTenantBySlug(slug: string): Promise<ITenant | null>;
  findTenantById(id: string): Promise<ITenant | null>;
  findAllTenants(query: RequestQuery): Promise<PaginatedResponse<ITenant>>;
  createTenant(data: Partial<ITenant>): Promise<ITenant>;
  updateTenant(id: string, data: Partial<ITenant>): Promise<ITenant>;
  softDeleteTenant(id: string): Promise<void>;
}
