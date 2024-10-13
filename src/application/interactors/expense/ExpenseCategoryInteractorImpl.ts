import { inject, injectable } from "inversify";
import { RequestQuery } from "../../../entities";
import { IExpenseCategory } from "../../../entities/Expense";
import { IExpenseCategoryRepository } from "../../../frameworks/database/mongodb/repositories/expense/IExpenseCategoryRepository";
import { IExpenseCategoryInteractor } from "./IExpenseCategoryInteractor";
import { INTERFACE_TYPE } from "../../../utils";
import {
  BadRequestError,
  NotFoundError,
  UnprocessableEntityError,
} from "../../../error_handler";

@injectable()
export class ExpenseCategoryInteractorImpl
  implements IExpenseCategoryInteractor
{
  private repository: IExpenseCategoryRepository;

  constructor(
    @inject(INTERFACE_TYPE.ExpenseCategoryRepositoryImpl)
    expenseCategoryRepository: IExpenseCategoryRepository
  ) {
    this.repository = expenseCategoryRepository;
  }
  async getAllExpenseCategory(
    query: RequestQuery
  ): Promise<IExpenseCategory[]> {
    return await this.repository.findAll(query);
  }
  async getAnExpenseCategory(
    id: string
  ): Promise<IExpenseCategory | null | undefined> {
    if (!id)
      throw new UnprocessableEntityError("Category expense id is required");
    const category = await this.repository.findById(id);
    if (!category) throw new NotFoundError("Category expense not found");
    return category;
  }
  async addExpenseCategory(data: IExpenseCategory): Promise<IExpenseCategory> {
    if (!data)
      throw new UnprocessableEntityError("Expense Category data is required");

    //TODO validate data
    const expenseCategory = await this.repository.save(data);
    if (!expenseCategory)
      throw new BadRequestError("Error while adding expense category");
    return expenseCategory;
  }
  async updateExpenseCategory(
    id: string,
    data: IExpenseCategory
  ): Promise<IExpenseCategory> {
    if (!id)
      throw new UnprocessableEntityError("Expense Category id is required");
    const category = await this.repository.findById(id);
    if (!category) throw new NotFoundError("Expense Category not found");
    const updatedCategory = await this.repository.update(id, data);
    if (!updatedCategory)
      throw new BadRequestError("Error while updating Expense Category");
    return updatedCategory;
  }
  async deleteExpenseCategory(id: string): Promise<IExpenseCategory> {
    if (!id)
      throw new UnprocessableEntityError("Category expense id is required");
    const deletedCategory = await this.repository.delete(id);
    if (!deletedCategory)
      throw new BadRequestError("Error deleting expense category");
    return deletedCategory;
  }
}
