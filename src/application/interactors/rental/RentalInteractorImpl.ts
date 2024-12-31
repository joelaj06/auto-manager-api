import { inject, injectable } from "inversify";
import { IRentalInteractor } from "./IRentalInteractor";
import {
  RentalRequestQuery,
  PaginatedResponse,
  IRental,
  IRentalExtension,
} from "../../../entities";
import { INTERFACE_TYPE } from "../../../utils";
import { IRentalRepository, IVehicleRepository } from "../../../frameworks";
import Rental from "../../../frameworks/database/mongodb/models/rental";
import { IVehicle } from "../../../entities/Vehicle";
import {
  BadRequestError,
  NotFoundError,
  UnprocessableEntityError,
} from "../../../error_handler";

@injectable()
export class RentalInteractorImpl implements IRentalInteractor {
  private rentalRepository: IRentalRepository;
  private vehicleRepository: IVehicleRepository;
  constructor(
    @inject(INTERFACE_TYPE.RentalRepositoryImpl)
    rentalRepository: IRentalRepository,
    @inject(INTERFACE_TYPE.VehicleRepositoryImpl)
    vehicleRepository: IVehicleRepository
  ) {
    this.rentalRepository = rentalRepository;
    this.vehicleRepository = vehicleRepository;
  }
  async removeExtension(rentalId: string, indexes: number[]): Promise<IRental> {
    if (!rentalId) throw new UnprocessableEntityError("Rental id is required");

    const rental = await this.rentalRepository.findById(rentalId);
    if (!rental) throw new NotFoundError("Rental not found");

    const extensions: IRentalExtension[] = [...(rental.extensions ?? [])];

    if (extensions.length < 1)
      throw new NotFoundError("No extensions found for this rental");

    if (indexes.some((idx) => idx < 0 || idx >= extensions.length))
      throw new UnprocessableEntityError("Invalid indexes");

    const totalAmount = rental.totalAmount ?? 0;
    const balance = rental.balance ?? 0;

    // Calculate updated totalAmount and balance
    let updatedTotalAmount = totalAmount;
    let updatedBalance = balance;

    indexes.forEach((idx) => {
      const extendedAmount = extensions[idx]?.extendedAmount ?? 0;
      updatedTotalAmount -= extendedAmount;
      updatedBalance += extendedAmount;
    });

    // Remove extensions by filtering out the specified indexes
    const updatedExtensions = extensions.filter(
      (_, index) => !indexes.includes(index)
    );

    // Prepare the updated rental data
    const updatedRentalData: IRental = {
      ...rental,
      totalAmount: updatedTotalAmount,
      balance: updatedBalance,
      extensions: updatedExtensions,
    };

    // Persist the updated rental data
    const updatedRental = await this.rentalRepository.update(
      rentalId,
      updatedRentalData
    );
    if (!updatedRental)
      throw new BadRequestError("Error while updating Rental");

    return updatedRental;
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

    if (!data.vehicle)
      throw new UnprocessableEntityError("Vehicle id is required");
    const vehicleId = data.vehicle.toString();
    //calculate the balance
    const balance = Number(data.amountPaid) - Number(data.totalAmount);
    data.balance = balance;

    //check if vehicle is available
    const vehicle = await this.vehicleRepository.findById(vehicleId);
    if (!vehicle) throw new UnprocessableEntityError("Vehicle not found");
    if (vehicle.status == "rented" || vehicle.rentalStatus == true)
      throw new UnprocessableEntityError("Vehicle is already rented");

    const rentedVehicle: IVehicle = {
      status: "rented",
      rentalStatus: true,
    };

    await this.vehicleRepository.updateVehicle(vehicleId, rentedVehicle);
    const rental = await this.rentalRepository.save(data);
    if (!rental) throw new BadRequestError("Error while adding rental");
    return rental;
  }
  async updateRental(id: string, data: IRental): Promise<IRental> {
    if (!id) throw new UnprocessableEntityError("Rental id is required");
    const rental = await this.rentalRepository.findById(id);
    if (!rental) throw new NotFoundError("Rental not found");

    const balance = Number(data.amountPaid) - Number(rental.totalAmount);
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
