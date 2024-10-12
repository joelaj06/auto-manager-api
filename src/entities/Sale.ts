import { IDriver } from "./Driver";
import { RequestQuery } from "./User";
import { IVehicle } from "./Vehicle";

export class ISale {
  constructor(
    public readonly _id?: string,
    public saleId?: string,
    public readonly driverId?: string,
    public readonly vehicleId?: string,
    public readonly amount?: number,
    public readonly date?: Date,
    public readonly company?: string,
    public readonly status?: string, // e.g., 'pending', 'approved', 'rejected'
    public readonly createdBy?: string, // User who created the sale entry
    public readonly updatedBy?: string, // User who last updated the sale entry
    public readonly createdAt?: Date,
    public readonly updatedAt?: Date,
    public readonly driver?: IDriver | string, // Optional populated driver entity
    public readonly vehicle?: IVehicle | string,
    public approvedOrRejectedBy?: string
  ) {}
}

export interface SalesRequestQuery extends RequestQuery {
  status?: "pending" | "approved" | "rejected";
  driverId?: string;
  vehicleId?: string;
  companyId?: string;
  date?: string;
}
