import { injectable } from "inversify";
import { IExpenseRepository } from "./IExpenseRespository";
import { RequestQuery, PaginatedResponse } from "../../../../../entities";
import { ExpenseRequestQuery, IExpense } from "../../../../../entities/Expense";
import { Expense, ExpenseCategory, ExpenseMapper } from "../../models";

@injectable()
export class ExpenseRepositoryImpl implements IExpenseRepository {
  async save(data: IExpense): Promise<IExpense> {
    try {
      if (!data) throw new Error("Expensedata is required");
      const newExpense = new Expense(data);
      await newExpense.save();
      return ExpenseMapper.toEntity(newExpense);
    } catch (error) {
      throw error;
    }
  }
  async update(id: string, data: IExpense): Promise<IExpense> {
    try {
      if (!id) throw new Error("ExpenseCategory id is required");
      if (!data) throw new Error("ExpenseCategory data is required");

      const updatedExpense = await Expense.findByIdAndUpdate(id, data, {
        new: true,
      });

      if (!updatedExpense) throw new Error("Expense not found");

      return ExpenseMapper.toEntity(updatedExpense);
    } catch (error) {
      throw error;
    }
  }
  async delete(id: string): Promise<IExpense> {
    try {
      if (!id) throw new Error("Expense id is required");
      const deletedExpense = await Expense.findByIdAndDelete(id);
      if (!deletedExpense) throw new Error("Expense not found");
      return ExpenseMapper.toEntity(deletedExpense);
    } catch (error) {
      throw error;
    }
  }
  async findAll(
    query: ExpenseRequestQuery
  ): Promise<PaginatedResponse<IExpense>> {
    try {
      const { search, pageSize, status, categoryId } = query;
      const searchQuery = search || "";
      const limit = pageSize || 10;
      const pageIndex = query.pageIndex || 1;
      const startIndex = (pageIndex - 1) * limit;
      let searchCriteria = {};

      if (searchQuery) {
        searchCriteria = {
          $or: [
            { name: { $regex: new RegExp(`^${searchQuery}.*`, "i") } },
            { description: { $regex: new RegExp(`^${searchQuery}.*`, "i") } },
          ],
        };
      }

      if (status) {
        searchCriteria = {
          ...searchCriteria,
          status,
        };
      }

      if (categoryId) {
        searchCriteria = {
          ...searchCriteria,
          categoryId,
        };
      }

      const expenses = await Expense.find(searchCriteria)
        .limit(limit)
        .skip(startIndex)
        .populate("category")
        .populate("vehicle")
        .populate("incurredBy", "-password");

      const data: IExpense[] = expenses.map((category) =>
        ExpenseMapper.toEntity(category)
      );

      const totalCount = await Expense.countDocuments(searchCriteria);

      const totalPages = Math.ceil(totalCount / limit);

      const paginatedRes: PaginatedResponse<IExpense> = {
        data,
        totalPages,
        totalCount,
        pageCount: pageIndex,
      };

      return paginatedRes;
    } catch (error) {
      throw error;
    }
  }
  async findById(id: string): Promise<IExpense | null | undefined> {
    if (!id) throw new Error("Expense id is required");
    const expense = await Expense.findById(id)
      .populate("category")
      .populate("vehicle")
      .populate("incurredBy", "-password");
    if (!expense) return null;
    return ExpenseMapper.toEntity(expense);
  }
}
