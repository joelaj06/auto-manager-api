import { inject, injectable } from "inversify";
import { IVehicle, RequestQuery, PaginatedResponse } from "../../../entities";
import {
  BadRequestError,
  NotFoundError,
  UnprocessableEntityError,
} from "../../../error_handler";
import { IVehicleInteractor } from "./IVehicleInteractor";
import { IVehicleRepository } from "../../../frameworks/database/mongodb/repositories/vehicle/IVehicleRepository";
import { INTERFACE_TYPE } from "../../../utils";

@injectable()
export class VehicleInteractorImpl implements IVehicleInteractor {
  private repository: IVehicleRepository;

  constructor(
    @inject(INTERFACE_TYPE.VehicleRepositoryImpl)
    vehicleRepository: IVehicleRepository
  ) {
    this.repository = vehicleRepository;
  }
  async addVehicle(data: IVehicle): Promise<IVehicle> {
    if (!data) throw new UnprocessableEntityError("Vehicle data is required");
    //TODO validate data
    const vehicle = await this.repository.addVehicle(data);
    if (!vehicle) throw new BadRequestError("Error while adding vehicle");
    return vehicle;
  }
  async updateVehicle(id: string, data: IVehicle): Promise<IVehicle> {
    if (!id) throw new UnprocessableEntityError("Vehicle id is required");
    const vehicle = await this.repository.findById(id);
    if (!vehicle) throw new NotFoundError("Vehicle not found");
    const updatedVehicle = await this.repository.updateVehicle(id, data);
    if (!updatedVehicle)
      throw new BadRequestError("Error while updating Vehicle");
    return updatedVehicle;
  }
  async deleteVehicle(id: string): Promise<IVehicle> {
    if (!id) throw new UnprocessableEntityError("Vehicle id is required");
    const deletedVehicle = await this.repository.deleteVehicle(id);
    if (!deletedVehicle) throw new BadRequestError("Error deleting vehicle");
    return deletedVehicle;
  }
  async getAllVehicles(
    query: RequestQuery
  ): Promise<PaginatedResponse<IVehicle>> {
    return await this.repository.findAllVehicles(query);
  }
  async getAVehicle(id: string): Promise<IVehicle> {
    if (!id) throw new UnprocessableEntityError("Vehicle id is required");
    const vehicle = await this.repository.findById(id);
    if (!vehicle) throw new NotFoundError("Vehicle not found");
    return vehicle;
  }
}
