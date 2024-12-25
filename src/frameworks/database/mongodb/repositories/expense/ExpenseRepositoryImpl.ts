import { injectable } from "inversify";
import { IExpenseRepository } from "./IExpenseRespository";
import { RequestQuery, PaginatedResponse } from "../../../../../entities";
import { ExpenseRequestQuery, IExpense } from "../../../../../entities/Expense";
import { Expense, ExpenseCategory, ExpenseMapper } from "../../models";
import mongoose from "mongoose";
import { BadRequestError } from "../../../../../error_handler";

@injectable()
export class ExpenseRepositoryImpl implements IExpenseRepository {
  async save(data: IExpense): Promise<IExpense> {
    try {
      if (!data) throw new Error("Expensedata is required");
      const newExpense = new Expense(data);
      await newExpense.save();
      if (!newExpense) throw new BadRequestError("Failed to create Expense");
      const expense = await Expense.findById(newExpense._id)
        .populate("category")
        .populate("vehicle")
        .populate("incurredBy", "-password");
      return ExpenseMapper.toEntity(expense);
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
      })
        .populate("category")
        .populate("vehicle")
        .populate("incurredBy", "-password");

      if (!updatedExpense) throw new Error("Expense not found");

      return ExpenseMapper.toEntity(updatedExpense);
    } catch (error) {
      throw error;
    }
  }
  async delete(id: string): Promise<IExpense> {
    try {
      if (!id) throw new Error("Expense id is required");
      const deletedExpense = await Expense.findByIdAndUpdate(
        id,
        {
          isDeleted: true,
          deletedAt: new Date(),
        },
        {
          new: true,
        }
      );
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
      const {
        search,
        pageSize,
        status,
        categoryId,
        vehicleId,
        companyId,
        startDate,
        endDate,
      } = query;
      const searchQuery = search || "";
      const limit = pageSize || 10;
      const pageIndex = query.pageIndex || 1;
      const startIndex = (pageIndex - 1) * limit;
      let searchCriteria = {};

      if (companyId) {
        searchCriteria = {
          ...searchCriteria,
          company: new mongoose.Types.ObjectId(companyId),
        };
      }

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
          category: new mongoose.Types.ObjectId(categoryId),
        };
      }

      if (vehicleId) {
        searchCriteria = {
          ...searchCriteria,
          vehicle: new mongoose.Types.ObjectId(vehicleId),
        };
      }

      if (startDate) {
        searchCriteria = {
          ...searchCriteria,
          date: {
            $gte: new Date(startDate),
            $lte: new Date(endDate ?? new Date()),
          },
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

      const aggregationPipeline = [];
      if (Object.keys(searchCriteria).length > 0) {
        aggregationPipeline.push({ $match: searchCriteria });
      }
      aggregationPipeline.push({
        $group: { _id: null, totalExpense: { $sum: "$amount" } },
      });

      const totalExpenseAggregation = await Expense.aggregate(
        aggregationPipeline
      );

      const totalExpense = totalExpenseAggregation[0]?.totalExpense || 0;

      const paginatedRes: PaginatedResponse<IExpense> = {
        totalSum: totalExpense,
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
