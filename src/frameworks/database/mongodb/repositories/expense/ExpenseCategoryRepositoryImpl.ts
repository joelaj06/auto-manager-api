import { injectable } from "inversify";
import { RequestQuery } from "../../../../../entities";
import { IExpenseCategory } from "../../../../../entities/Expense";
import { ExpenseCategory, ExpenseCategoryMapper } from "../../models";
import { IExpenseCategoryRepository } from "./IExpenseCategoryRepository";

@injectable()
export class ExpenseCategoryRepositoryImpl
  implements IExpenseCategoryRepository
{
  async save(data: IExpenseCategory): Promise<IExpenseCategory> {
    try {
      if (!data) throw new Error("ExpenseCategory data is required");
      const newExpenseCategory = new ExpenseCategory(data);
      await newExpenseCategory.save();
      return ExpenseCategoryMapper.toEntity(newExpenseCategory);
    } catch (error) {
      throw error;
    }
  }
  async update(id: string, data: IExpenseCategory): Promise<IExpenseCategory> {
    try {
      if (!id) throw new Error("ExpenseCategory id is required");
      if (!data) throw new Error("ExpenseCategory data is required");

      const updatedExpenseCategory = await ExpenseCategory.findByIdAndUpdate(
        id,
        data,
        {
          new: true,
        }
      );

      if (!updatedExpenseCategory) throw new Error("ExpenseCategory not found");

      return ExpenseCategoryMapper.toEntity(updatedExpenseCategory);
    } catch (error) {
      throw error;
    }
  }
  async delete(id: string): Promise<IExpenseCategory> {
    try {
      if (!id) throw new Error("ExpenseCategory id is required");
      const deletedExpenseCategory = await ExpenseCategory.findByIdAndDelete(
        id
      );
      if (!deletedExpenseCategory) throw new Error("ExpenseCategory not found");
      return ExpenseCategoryMapper.toEntity(deletedExpenseCategory);
    } catch (error) {
      throw error;
    }
  }
  async findAll(query: RequestQuery): Promise<IExpenseCategory[]> {
    try {
      const searchQuery = query.search || "";
      const searchCriteria = {
        $or: [
          { name: { $regex: new RegExp(`^${searchQuery}.*`, "i") } },
          { description: { $regex: new RegExp(`^${searchQuery}.*`, "i") } },
        ],
      };

      const expenseCategories = await ExpenseCategory.find(searchCriteria);

      const data: IExpenseCategory[] = expenseCategories.map((category) =>
        ExpenseCategoryMapper.toEntity(category)
      );

      return data;
    } catch (error) {
      throw error;
    }
  }
  async findById(id: string): Promise<IExpenseCategory | null | undefined> {
    if (!id) throw new Error("ExpenseCategory id is required");
    const category = await ExpenseCategory.findById(id);
    if (!category) return null;
    return ExpenseCategoryMapper.toEntity(category);
  }
}
