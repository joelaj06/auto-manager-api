import { ICustomer } from "./Customer";
import { RequestQuery } from "./User";
import { IVehicle } from "./Vehicle";

export class IRental {
  constructor(
    public readonly _id?: string,
    public rentalCode?: string,
    public readonly renter?: ICustomer | string,
    public readonly vehicle?: IVehicle | string,
    public readonly startDate?: Date,
    public readonly endDate?: Date,
    public readonly cost?: number,
    public readonly status?: string, // e.g., "active", "completed", "canceled"
    public readonly createdBy?: string, // User who created the rental
    public readonly updatedBy?: string, // User who last updated the rental
    public readonly note?: string,
    public readonly company?: string,
    public readonly createdAt?: Date,
    public readonly updatedAt?: Date,
    public readonly purpose?: string,
    public readonly amountPaid?: number,
    public balance?: number,
    public readonly totalAmount?: number,
    public readonly receiptNumber?: string,
    public readonly dateReturned?: Date,
    public readonly extensions?: IRentalExtension[],
    public readonly date?: Date
  ) {}
}

export class IRentalExtension {
  constructor(
    public readonly extendedBalance?: number,
    public readonly extendedAmount?: number,
    public readonly extendedDate?: Date,
    public readonly extendedNote?: string,
    public readonly extendedBy?: string
  ) {}
}
export interface RentalRequestQuery extends RequestQuery {
  vehicleId?: string;
  renter?: string;
}
