import { IVehicle, PaginatedResponse, RequestQuery } from "../../../entities";

export interface IVehicleInteractor {
  addVehicle(data: IVehicle): Promise<IVehicle>;
  updateVehicle(id: string, data: IVehicle): Promise<IVehicle>;
  deleteVehicle(id: string): Promise<IVehicle>;
  getAllVehicles(query: RequestQuery): Promise<PaginatedResponse<IVehicle>>;
  getAVehicle(id: string): Promise<IVehicle>;
}
