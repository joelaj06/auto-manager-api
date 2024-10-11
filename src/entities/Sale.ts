import { IDriver } from "./Driver";
import { IVehicle } from "./Vehicle";

export class ISale {
  constructor(
    public readonly _id?: string,
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
    public readonly vehicle?: IVehicle | string // Optional populated vehicle entity
  ) {}
}
