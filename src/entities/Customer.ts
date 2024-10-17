import { IRental } from "./Rental";

export class ICustomer {
  constructor(
    public readonly _id?: string,
    public readonly name?: string,
    public customerCode?: string,
    public readonly email?: string,
    public readonly phone?: string,
    public readonly address?: string,
    public readonly company?: string,
    public readonly business?: string,
    public readonly occupation?: string,
    public readonly identificationNumber?: string, // e.g., National ID, Driver's License, etc.
    public readonly dateOfBirth?: Date,
    public readonly rentalHistory?: IRental[] | string[], // Reference to the rentals
    public readonly createdAt?: Date,
    public readonly updatedAt?: Date
  ) {}
}
