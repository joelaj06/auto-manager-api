import { ITenant, PaginatedResponse, RequestQuery } from "../../../entities";

export interface ITenantInteractor {
  createTenant(data: Partial<ITenant>): Promise<ITenant>;
  getAllTenants(query: RequestQuery): Promise<PaginatedResponse<ITenant>>;
  getTenant(id: string): Promise<ITenant>;
  updateTenant(id: string, data: Partial<ITenant>): Promise<ITenant>;
  deleteTenant(id: string): Promise<void>;
  activateTenant(id: string): Promise<ITenant>;
  deactivateTenant(id: string): Promise<ITenant>;
  suspendTenant(id: string): Promise<ITenant>;
  renewSubscription(id: string, expiresAt: Date): Promise<ITenant>;
}
