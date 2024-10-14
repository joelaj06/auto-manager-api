import { PaginatedResponse, RequestQuery } from "../../../../../entities";
import { ExpenseRequestQuery, IExpense } from "../../../../../entities/Expense";

export interface IExpenseRepository {
  save(data: IExpense): Promise<IExpense>;
  update(id: string, data: IExpense): Promise<IExpense>;
  delete(id: string): Promise<IExpense>;
  findAll(query: ExpenseRequestQuery): Promise<PaginatedResponse<IExpense>>;
  findById(id: string): Promise<IExpense | null | undefined>;
}
