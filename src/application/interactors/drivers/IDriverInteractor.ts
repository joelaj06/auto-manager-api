import { IDriver, PaginatedResponse, RequestQuery } from "../../../entities";

export interface IDriverInteractor {
  getAllDrivers(query: RequestQuery): Promise<PaginatedResponse<IDriver>>;
  getADriver(id: string): Promise<IDriver>;
  addDriver(data: IDriver): Promise<IDriver>;
  updateDriver(id: string, data: IDriver): Promise<IDriver>;
  deleteDriver(id: string): Promise<IDriver>;
}
