import {
  IDriver,
  PaginatedResponse,
  RequestQuery,
} from "../../../../../entities";

export interface IDriverRepository {
  findAll(query: RequestQuery): Promise<PaginatedResponse<IDriver>>;
  findById(id: string): Promise<IDriver | null | undefined>;
  addDriver(data: IDriver): Promise<IDriver>;
  updateDriver(id: string, data: IDriver): Promise<IDriver>;
  deleteDriver(id: string): Promise<IDriver>;
  findDriverByUserId(id: string): Promise<IDriver | null | undefined>;
}
