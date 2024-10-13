import { RequestQuery } from "../../../../../entities";
import { IExpenseCategory } from "../../../../../entities/Expense";

export interface IExpenseCategoryRepository {
  save(data: IExpenseCategory): Promise<IExpenseCategory>;
  update(id: string, data: IExpenseCategory): Promise<IExpenseCategory>;
  delete(id: string): Promise<IExpenseCategory>;
  findAll(query: RequestQuery): Promise<IExpenseCategory[]>;
  findById(id: string): Promise<IExpenseCategory | null | undefined>;
}
