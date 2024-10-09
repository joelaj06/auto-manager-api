import {
  IVehicle,
  PaginatedResponse,
  RequestQuery,
} from "../../../../../entities";

export interface IVehicleRepository {
  findById(id: string): Promise<IVehicle | null | undefined>;
  findAllVehicles(query: RequestQuery): Promise<PaginatedResponse<IVehicle>>;
  addVehicle(data: IVehicle): Promise<IVehicle>;
  updateVehicle(id: string, data: IVehicle): Promise<IVehicle>;
  deleteVehicle(id: string): Promise<IVehicle>;
}
