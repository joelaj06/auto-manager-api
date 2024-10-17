import { ICustomer, RequestQuery, PaginatedResponse } from "../../../entities";

export interface ICustomerInteractor {
  saveCustomer(data: ICustomer): Promise<ICustomer>;
  updateCustomer(id: string, data: ICustomer): Promise<ICustomer>;
  deleteCustomer(id: string): Promise<ICustomer>;
  getAllCustomers(query: RequestQuery): Promise<PaginatedResponse<ICustomer>>;
  getACustomer(id: string): Promise<ICustomer>;
}
