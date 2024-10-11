import { ISale, PaginatedResponse, RequestQuery } from "../../../entities";

export interface ISalesInteractor {
  getAllSales(query: RequestQuery): Promise<PaginatedResponse<ISale>>;
  getASale(id: string): Promise<ISale>;
  addSale(data: ISale): Promise<ISale>;
  updateSale(id: string, data: ISale): Promise<ISale>;
  deleteSale(id: string): Promise<ISale>;
}
