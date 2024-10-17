import {
  ICustomer,
  PaginatedResponse,
  RequestQuery,
} from "../../../../../entities";

export interface ICustomerRepository {
  save(data: ICustomer): Promise<ICustomer>;

  update(id: string, data: ICustomer): Promise<ICustomer>;

  delete(id: string): Promise<ICustomer>;

  findAll(query: RequestQuery): Promise<PaginatedResponse<ICustomer>>;

  findById(id: string): Promise<ICustomer | null | undefined>;
}
