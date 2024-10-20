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
import { IStorageBucket } from "../../../frameworks/services/bucket/IStorageBucket";

@injectable()
export class VehicleInteractorImpl implements IVehicleInteractor {
  private repository: IVehicleRepository;
  private bucket: IStorageBucket;

  constructor(
    @inject(INTERFACE_TYPE.VehicleRepositoryImpl)
    vehicleRepository: IVehicleRepository,
    @inject(INTERFACE_TYPE.StorageBucketImpl) bucket: IStorageBucket
  ) {
    this.repository = vehicleRepository;
    this.bucket = bucket;
  }
  async addVehicle(data: IVehicle): Promise<IVehicle> {
    if (!data) throw new UnprocessableEntityError("Vehicle data is required");
    //TODO validate data
    let body = { ...data };

    let image: string = data.image || "";

    if (!image.startsWith("http") && image != "") {
      // Image is in base64 format, so upload it
      const imageUrl = await this.bucket.uploadImage(image);
      body = { ...body, image: imageUrl };
    } else {
      body = { ...body, image: "" };
    }

    const vehicle = await this.repository.addVehicle(body);
    if (!vehicle) throw new BadRequestError("Error while adding vehicle");
    return vehicle;
  }
  async updateVehicle(id: string, data: IVehicle): Promise<IVehicle> {
    if (!id) throw new UnprocessableEntityError("Vehicle id is required");

    const vehicle = await this.repository.findById(id);
    if (!vehicle) throw new NotFoundError("Vehicle not found");
    let body = { ...data };

    let image: string = data.image || "";

    if (!image.startsWith("http") && image != "") {
      // Image is in base64 format, so upload it
      const imageUrl = await this.bucket.uploadImage(image);
      body = { ...body, image: imageUrl };
    } else {
      body = { ...body, image: "" };
    }
    const updatedVehicle = await this.repository.updateVehicle(id, body);
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
