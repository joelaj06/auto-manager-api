import { IExpenseCategory } from "../../../entities/Expense";
import { RequestQuery } from "../../../entities/User";

export interface IExpenseCategoryInteractor {
  getAllExpenseCategory(query: RequestQuery): Promise<IExpenseCategory[]>;
  getAnExpenseCategory(
    id: string
  ): Promise<IExpenseCategory | null | undefined>;
  addExpenseCategory(data: IExpenseCategory): Promise<IExpenseCategory>;
  updateExpenseCategory(
    id: string,
    data: IExpenseCategory
  ): Promise<IExpenseCategory>;
  deleteExpenseCategory(id: string): Promise<IExpenseCategory>;
}
