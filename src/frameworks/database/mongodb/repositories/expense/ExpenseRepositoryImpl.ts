import { injectable } from "inversify";
import { IExpenseRepository } from "./IExpenseRespository";
import { RequestQuery, PaginatedResponse } from "../../../../../entities";
import { IExpense } from "../../../../../entities/Expense";

@injectable()
export class ExpenseRepositoryImpl implements IExpenseRepository {
  save(data: IExpense): Promise<IExpense> {
    throw new Error("Method not implemented.");
  }
  update(id: string, data: IExpense): Promise<IExpense> {
    throw new Error("Method not implemented.");
  }
  delete(id: string): Promise<IExpense> {
    throw new Error("Method not implemented.");
  }
  findAll(query: RequestQuery): Promise<PaginatedResponse<IExpense>> {
    throw new Error("Method not implemented.");
  }
  findById(id: string): Promise<IExpense | null | undefined> {
    throw new Error("Method not implemented.");
  }
}
