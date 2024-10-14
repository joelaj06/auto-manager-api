import {
  ExpenseRequestQuery,
  IExpense,
  PaginatedResponse,
} from "../../../entities";

export interface IExpenseInteractor {
  addExpense(data: IExpense): Promise<IExpense>;
  updateExpense(id: string, data: IExpense): Promise<IExpense>;
  deleteExpense(id: string): Promise<IExpense>;
  getAllExpenses(
    query: ExpenseRequestQuery
  ): Promise<PaginatedResponse<IExpense>>;
  getAnExpense(id: string): Promise<IExpense | null | undefined>;
}
