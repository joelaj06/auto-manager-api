import { ICompany } from "./Company";
import { IUser, RequestQuery } from "./User";
import { IVehicle } from "./Vehicle";

export class IExpense {
  constructor(
    public readonly _id?: string,
    public expenseId?: string,
    public readonly category?: IExpenseCategory | string,
    public readonly status?: string,
    public readonly categoryId?: string,
    public readonly company?: ICompany | string,
    public readonly amount?: number,
    public readonly description?: string, // Optional description for additional details
    public readonly incurredBy?: IUser | string, // Reference to the User or Driver who incurred the expense
    public readonly vehicle?: IVehicle | string, // Optional: The vehicle associated with the expense, if applicable
    public readonly date?: Date, // Date the expense was incurred
    public readonly createdAt?: Date, // Timestamp for when the expense was created
    public readonly updatedAt?: Date // Timestamp for the last update to the expense
  ) {}
}

export class IExpenseCategory {
  constructor(
    public readonly _id?: string,
    public readonly name?: string,
    public readonly description?: string,
    public readonly createdBy?: string,
    public readonly createdAt?: string,
    public readonly updatedAt?: string
  ) {}
}

export interface ExpenseRequestQuery extends RequestQuery {
  categoryId?: string;
  status?: string;
  vehicleId?: string;
}
