import {
  IRental,
  IRentalExtension,
  PaginatedResponse,
  RentalRequestQuery,
} from "../../../entities";

export interface IRentalInteractor {
  getAllRentals(query: RentalRequestQuery): Promise<PaginatedResponse<IRental>>;
  getARental(id: string): Promise<IRental>;
  addRental(data: IRental): Promise<IRental>;
  updateRental(id: string, data: IRental): Promise<IRental>;
  deleteRental(id: string): Promise<IRental>;
  extendRental(id: string, data: IRentalExtension): Promise<IRental>;
  removeExtension(rentalId: string, indexes: number[]): Promise<IRental>;
}
