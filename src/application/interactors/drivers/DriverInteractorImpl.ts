import { inject, injectable } from "inversify";
import { IDriverRepository } from "../../../frameworks/database/mongodb/repositories/driver/IDriverRepository";
import { INTERFACE_TYPE } from "../../../utils";
import { IDriverInteractor } from "./IDriverInteractor";
import { RequestQuery, PaginatedResponse, IDriver } from "../../../entities";
import {
  BadRequestError,
  NotFoundError,
  UnprocessableEntityError,
} from "../../../error_handler";

@injectable()
export class DriverInteractorImpl implements IDriverInteractor {
  public driverRepository: IDriverRepository;

  constructor(
    @inject(INTERFACE_TYPE.DriverRepositoryImpl)
    driverRepository: IDriverRepository
  ) {
    this.driverRepository = driverRepository;
  }
  async getAllDrivers(
    query: RequestQuery
  ): Promise<PaginatedResponse<IDriver>> {
    return await this.driverRepository.findAll(query);
  }
  async getADriver(id: string): Promise<IDriver> {
    if (!id) throw new UnprocessableEntityError("Driver id is required");
    const driver = await this.driverRepository.findById(id);
    if (!driver) throw new NotFoundError("Driver not found");
    return driver;
  }
  async addDriver(data: IDriver): Promise<IDriver> {
    if (!data) throw new UnprocessableEntityError("Driver data is required");
    //TODO validate data
    const driver = await this.driverRepository.addDriver(data);
    if (!driver) throw new BadRequestError("Error while adding driver");
    return driver;
  }
  async updateDriver(id: string, data: IDriver): Promise<IDriver> {
    if (!id) throw new UnprocessableEntityError("Driver id is required");
    const driver = await this.driverRepository.findById(id);
    if (!driver) throw new NotFoundError("Driver not found");

    const updatedDriver = await this.driverRepository.updateDriver(id, data);

    if (!updatedDriver)
      throw new BadRequestError("Error while updating Driver");

    return updatedDriver;
  }
  async deleteDriver(id: string): Promise<IDriver> {
    if (!id) throw new UnprocessableEntityError("Driver id is required");
    const deletedDriver = await this.driverRepository.deleteDriver(id);
    if (!deletedDriver) throw new BadRequestError("Error deleting driver");
    return deletedDriver;
  }
}
