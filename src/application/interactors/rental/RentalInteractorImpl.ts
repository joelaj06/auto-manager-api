import { inject, injectable } from "inversify";
import { IRentalInteractor } from "./IRentalInteractor";
import {
  RentalRequestQuery,
  PaginatedResponse,
  IRental,
  IRentalExtension,
} from "../../../entities";
import { INTERFACE_TYPE } from "../../../utils";
import { IRentalRepository } from "../../../frameworks";
import Rental from "../../../frameworks/database/mongodb/models/rental";
import {
  BadRequestError,
  NotFoundError,
  UnprocessableEntityError,
} from "../../../error_handler";

@injectable()
export class RentalInteractorImpl implements IRentalInteractor {
  private rentalRepository: IRentalRepository;
  constructor(
    @inject(INTERFACE_TYPE.RentalRepositoryImpl)
    rentalRepository: IRentalRepository
  ) {
    this.rentalRepository = rentalRepository;
  }
  async extendRental(id: string, data: IRentalExtension): Promise<IRental> {
    if (!id) throw new UnprocessableEntityError("Rental id is required");
    const rental = await this.rentalRepository.findById(id);
    if (!rental) throw new NotFoundError("Rental not found");

    const extensions: IRentalExtension[] = [...rental.extensions!, data];
    const totalAmount = rental?.totalAmount ?? 0;
    const balance = rental?.balance ?? 0;
    const rentalData: IRental = {
      ...rental,
      totalAmount: totalAmount + (data.extendedAmount ?? 0),
      balance: balance - (data.extendedAmount ?? 0),
      extensions,
    };
    const updatedRental = this.rentalRepository.update(id, rentalData);
    if (!updatedRental)
      throw new BadRequestError("Error while updating Rental");
    return updatedRental;
  }
  getAllRentals(
    query: RentalRequestQuery
  ): Promise<PaginatedResponse<IRental>> {
    return this.rentalRepository.findAll(query);
  }
  async getARental(id: string): Promise<IRental> {
    if (!id) throw new UnprocessableEntityError("Rental id is required");
    const rental = await this.rentalRepository.findById(id);
    if (!rental) throw new NotFoundError("Rental not found");
    return rental;
  }
  async addRental(data: IRental): Promise<IRental> {
    if (!data) throw new UnprocessableEntityError("Rental data is required");
    //TODO validate data

    const balance = Number(data.amountPaid) - Number(data.totalAmount);
    data.balance = balance;
    const rental = await this.rentalRepository.save(data);
    if (!rental) throw new BadRequestError("Error while adding rental");
    return rental;
  }
  async updateRental(id: string, data: IRental): Promise<IRental> {
    if (!id) throw new UnprocessableEntityError("Rental id is required");
    const rental = await this.rentalRepository.findById(id);
    if (!rental) throw new NotFoundError("Rental not found");

    const balance = Number(data.amountPaid) - Number(data.totalAmount);
    data.balance = balance;
    const updatedRental = await this.rentalRepository.update(id, data);
    if (!updatedRental)
      throw new BadRequestError("Error while updating Rental");
    return updatedRental;
  }
  async deleteRental(id: string): Promise<IRental> {
    if (!id) throw new UnprocessableEntityError("Rental id is required");
    const deletedRental = await this.rentalRepository.delete(id);
    if (!deletedRental) throw new BadRequestError("Error deleting rental");
    return deletedRental;
  }
}
