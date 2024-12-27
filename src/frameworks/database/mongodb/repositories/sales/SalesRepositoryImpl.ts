import { injectable } from "inversify";
import {
  ISale,
  PaginatedResponse,
  SalesRequestQuery,
  DashboardRequestQery,
  IMonthlySales,
} from "../../../../../entities";
import Sale, { SalesMapper } from "../../models/sales";
import { ISalesRepository } from "./ISalesRepository";
import mongoose from "mongoose";

@injectable()
export class SalesRepositoryImpl implements ISalesRepository {
  async getMonthlySales(query: DashboardRequestQery): Promise<IMonthlySales> {
    try {
      const { month, year, company } = query;
      if (!query) throw new Error("Query is required");

      const salesData = await Sale.aggregate([
        // Match documents within the specified month, year, and company
        {
          $match: {
            company: new mongoose.Types.ObjectId(company),
            date: {
              $gte: new Date(year, month - 1, 1),
              $lt: new Date(year, month, 1),
            },
          },
        },
        // Add a `week` field based on the week number within the month
        {
          $addFields: {
            week: { $ceil: { $divide: [{ $dayOfMonth: "$date" }, 7] } }, // Convert day of the month to week number
          },
        },
        // Group by `week` and sum the `amount` for each week
        {
          $group: {
            _id: "$week",
            totalSales: { $sum: "$amount" },
          },
        },
        // Sort by week number
        { $sort: { _id: 1 } },
        // Format the output as required
        {
          $project: {
            week: "$_id",
            totalSales: "$totalSales",
          },
        },
        // Group into the final format
        {
          $group: {
            _id: null,
            dates: { $push: "$week" },
            sales: { $push: "$totalSales" },
          },
        },
        {
          $project: {
            _id: 0,
            dates: 1,
            sales: 1,
          },
        },
      ]);

      const res: IMonthlySales = salesData.length
        ? {
            weeks: salesData[0].dates,
            sales: salesData[0].sales,
          }
        : { weeks: [], sales: [] };
      return res;
    } catch (error) {
      throw error;
    }
  }
  async addSale(data: ISale): Promise<ISale> {
    try {
      if (!data) throw new Error("Sales data is required");
      const newSale = new Sale(data);
      await newSale.save();
      return SalesMapper.toEntity(newSale);
    } catch (error) {
      throw error;
    }
  }
  async updateSale(id: string, data: ISale): Promise<ISale> {
    try {
      if (!id) throw new Error("Sale id is required");
      if (!data) throw new Error("Sale data is required");

      const updatedSale = await Sale.findByIdAndUpdate(id, data, {
        new: true,
      });

      if (!updatedSale) throw new Error("Sale not found");

      return SalesMapper.toEntity(updatedSale);
    } catch (error) {
      throw error;
    }
  }
  async deleteSale(id: string): Promise<ISale> {
    try {
      if (!id) throw new Error("Sale id is required");
      const deletedSale = await Sale.findByIdAndUpdate(
        id,
        {
          isDeleted: true,
          deletedAt: new Date(),
        },
        {
          new: true,
        }
      );
      if (!deletedSale) throw new Error("Sale not found");
      return SalesMapper.toEntity(deletedSale);
    } catch (error) {
      throw error;
    }
  }
  async findAll(query: SalesRequestQuery): Promise<PaginatedResponse<ISale>> {
    try {
      const {
        search,
        pageSize,
        status,
        driverId,
        vehicleId,
        companyId,
        date,
        startDate,
        endDate,
      } = query;
      const searchQuery = search || "";
      const limit = pageSize || 10;
      const pageIndex = query.pageIndex || 1;
      const startIndex = (pageIndex - 1) * limit;
      let searchCriteria = {};

      // Build the search criteria
      if (searchQuery) {
        searchCriteria = {
          $or: [{ saleId: { $regex: new RegExp(`^${searchQuery}.*`, "i") } }],
        };
      }

      if (status) searchCriteria = { ...searchCriteria, status };
      if (driverId)
        searchCriteria = {
          ...searchCriteria,
          driverId: new mongoose.Types.ObjectId(driverId),
        };
      if (vehicleId)
        searchCriteria = {
          ...searchCriteria,
          vehicleId: new mongoose.Types.ObjectId(vehicleId),
        };
      if (companyId)
        searchCriteria = {
          ...searchCriteria,
          company: new mongoose.Types.ObjectId(companyId),
        };
      if (date) searchCriteria = { ...searchCriteria, date };

      if (startDate) {
        searchCriteria = {
          ...searchCriteria,
          createdAt: {
            $gte: new Date(startDate),
            $lte: new Date(endDate ?? new Date()),
          },
        };
      }

      // Fetch paginated sales data with populated fields
      const sales = await Sale.find(searchCriteria)
        .populate("vehicle")
        .populate({
          path: "driver",
          populate: [
            { path: "user", select: "-password" },
            { path: "vehicle" },
          ],
        })
        .populate({
          path: "approvedOrRejectedBy",
          select: "-password",
        })
        .limit(limit)
        .skip(startIndex);

      const data: ISale[] = sales.map((sale) => SalesMapper.toEntity(sale));

      // Count total documents and total sales sum
      const totalCount = await Sale.countDocuments(searchCriteria);

      // Aggregate to calculate total sales sum
      // Perform aggregation conditionally
      const aggregationPipeline = [];
      if (Object.keys(searchCriteria).length > 0) {
        aggregationPipeline.push({ $match: searchCriteria });
      }
      aggregationPipeline.push({
        $group: { _id: null, totalSales: { $sum: "$amount" } },
      });

      const totalSalesAggregation = await Sale.aggregate(aggregationPipeline);

      const totalSales = totalSalesAggregation[0]?.totalSales || 0;

      const totalPages = Math.ceil(totalCount / limit);

      const response: PaginatedResponse<ISale> = {
        totalSum: totalSales, // Include total sales sum
        data,
        totalPages,
        totalCount,
        pageCount: pageIndex,
      };

      return response;
    } catch (error) {
      throw error;
    }
  }

  async findById(id: string): Promise<ISale | null | undefined> {
    try {
      if (!id) throw new Error("Sale id is required");
      const sale = await Sale.findById(id)
        .populate("vehicle")
        .populate({
          path: "driver", // Populate the driver
          populate: {
            path: "user",
            select: "-password", // Populate the user inside the driver
          },
        })
        .populate({
          path: "approvedOrRejectedBy", // Populate the driver
          select: "-password", // Populate the user inside the driver
        });
      if (!sale) return null;
      return SalesMapper.toEntity(sale);
    } catch (error) {
      throw error;
    }
  }
}
