import { IUser } from "./User";
import { IVehicle } from "./Vehicle";

export class IDriver {
  constructor(
    public readonly _id?: string,
    public driverCode?: string,
    public readonly licenseNumber?: string,
    public readonly lisenceExpiryDate?: Date,
    public readonly status?: string,
    public readonly vehicleId?: string,
    public readonly vehicle?: IVehicle | string,
    public readonly companyId?: string,
    public readonly userId?: string,
    public readonly user?: IUser | string,
    public readonly salesHistory?: {
      saleId: string;
      amount: number;
      date: Date;
    }[],
    public readonly createdAt?: Date,
    public readonly updatedAt?: Date,
    public readonly company?: string
  ) {}
}
