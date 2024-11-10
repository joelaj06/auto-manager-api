import { inject, injectable } from "inversify";
import { ISalesInteractor } from "./ISalesInteractor";
import { PaginatedResponse, ISale, SalesRequestQuery } from "../../../entities";
import { ISalesRepository } from "../../../frameworks/database/mongodb/repositories/sales";
import { INTERFACE_TYPE } from "../../../utils/constants";

import {
  BadRequestError,
  NotFoundError,
  UnprocessableEntityError,
} from "../../../error_handler";

@injectable()
export class SalesInteractorImpl implements ISalesInteractor {
  public salesRepository: ISalesRepository;
  constructor(
    @inject(INTERFACE_TYPE.SalesRepositoryImpl)
    salesRepository: ISalesRepository
  ) {
    this.salesRepository = salesRepository;
  }
  async getAllSales(
    query: SalesRequestQuery
  ): Promise<PaginatedResponse<ISale>> {
    const paginatedSales = await this.salesRepository.findAll(query);

    return paginatedSales;
  }
  async getASale(id: string): Promise<ISale> {
    if (!id) throw new UnprocessableEntityError("Sale id is required");
    const sale = await this.salesRepository.findById(id);
    if (!sale) throw new NotFoundError("Sale not found");
    return sale;
  }
  async addSale(data: ISale): Promise<ISale> {
    if (!data) throw new UnprocessableEntityError("Sale data is required");
    //TODO validate data
    //TODO add sale id (code)
    const salesData: ISale = {
      ...data,
      date: data.date || new Date(),
      vehicle: data.vehicleId,
      driver: data.driverId,
    };
    const sale = await this.salesRepository.addSale(salesData);
    if (!sale) throw new BadRequestError("Error while adding sale");
    const { vehicle, driver, ...rest } = sale;
    return rest;
  }
  async updateSale(id: string, data: ISale): Promise<ISale> {
    if (!id) throw new UnprocessableEntityError("Sale id is required");
    const sale = await this.salesRepository.findById(id);
    if (!sale) throw new NotFoundError("Sale not found");

    if (data.status !== "approved" && data.status !== "rejected") {
      data.approvedOrRejectedBy = undefined;
    }

    const updatedSale = await this.salesRepository.updateSale(id, data);

    if (!updatedSale) throw new BadRequestError("Error while updating Sale");

    return updatedSale;
  }
  async deleteSale(id: string): Promise<ISale> {
    if (!id) throw new UnprocessableEntityError("Sale id is required");
    const deletedSale = await this.salesRepository.deleteSale(id);
    if (!deletedSale) throw new BadRequestError("Error deleting sale");
    return deletedSale;
  }
}
