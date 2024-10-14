import { inject, injectable } from "inversify";
import { IExpenseInteractor } from "./IExpenseInteractor";
import { INTERFACE_TYPE } from "../../../utils";
import { IExpenseRepository } from "../../../frameworks";
import {
  IExpense,
  ExpenseRequestQuery,
  PaginatedResponse,
} from "../../../entities";
import {
  BadRequestError,
  NotFoundError,
  UnprocessableEntityError,
} from "../../../error_handler";

@injectable()
export class ExpenseInteractorImpl implements IExpenseInteractor {
  constructor(
    @inject(INTERFACE_TYPE.ExpenseRepositoryImpl)
    private repository: IExpenseRepository
  ) {}
  async addExpense(data: IExpense): Promise<IExpense> {
    if (!data) throw new UnprocessableEntityError("Expense data is required");

    //TODO validate data
    const expense = await this.repository.save(data);
    if (!expense) throw new BadRequestError("Error while adding expense");
    return expense;
  }
  async updateExpense(id: string, data: IExpense): Promise<IExpense> {
    if (!id) throw new UnprocessableEntityError("Expense  id is required");
    const expense = await this.repository.findById(id);
    if (!expense) throw new NotFoundError("Expense not found");
    const updatedExpense = await this.repository.update(id, data);
    if (!updatedExpense)
      throw new BadRequestError("Error while updating Expense");
    return updatedExpense;
  }
  async deleteExpense(id: string): Promise<IExpense> {
    if (!id) throw new UnprocessableEntityError("Expense id is required");
    const deletedExpense = await this.repository.delete(id);
    if (!deletedExpense) throw new BadRequestError("Error deleting expense");
    return deletedExpense;
  }
  async getAllExpenses(
    query: ExpenseRequestQuery
  ): Promise<PaginatedResponse<IExpense>> {
    return await this.repository.findAll(query);
  }
  async getAnExpense(id: string): Promise<IExpense | null | undefined> {
    if (!id) throw new UnprocessableEntityError("Expense id is required");
    const expense = await this.repository.findById(id);
    if (!expense) throw new NotFoundError("Expense not found");
    return expense;
  }
}
