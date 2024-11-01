import {
  DashboardRequestQery,
  IMonthlySales,
  ISale,
  PaginatedResponse,
  RequestQuery,
} from "../../../../../entities";

export interface ISalesRepository {
  addSale(data: ISale): Promise<ISale>;
  updateSale(id: string, data: ISale): Promise<ISale>;
  deleteSale(id: string): Promise<ISale>;
  findAll(query: RequestQuery): Promise<PaginatedResponse<ISale>>;
  findById(id: string): Promise<ISale | null | undefined>;
  getMonthlySales(query: DashboardRequestQery): Promise<IMonthlySales>;
}
