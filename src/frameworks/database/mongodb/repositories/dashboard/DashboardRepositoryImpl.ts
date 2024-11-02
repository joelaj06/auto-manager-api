import { injectable } from "inversify";
import { IDashboardRepository } from "./IDashboardRepository";
import { RequestQuery, IDashboardSummaryData } from "../../../../../entities";
import { Customer, Expense, Vehicle } from "../../models";
import company from "../../models/company";
import Driver from "../../models/driver";
import Sale from "../../models/sales";
import Rental from "../../models/rental";
import mongoose from "mongoose";

@injectable()
export class DashboardRepositoryImpl implements IDashboardRepository {
  async getDashboardSummaryData(
    query: RequestQuery
  ): Promise<IDashboardSummaryData> {
    const { companyId, startDate, endDate } = query;
    const matchCondition = {
      company: new mongoose.Types.ObjectId(companyId),
      date: { $gte: startDate, $lte: endDate },
    };

    const [
      salesData,
      driversCount,
      customersCount,
      vehiclesCount,
      rentalSalesData,
      expensesData,
    ] = await Promise.all([
      Sale.aggregate([
        { $match: matchCondition },
        { $group: { _id: null, totalSales: { $sum: "$amount" } } },
      ]),
      Driver.countDocuments({ company: companyId }),
      Customer.countDocuments({ company: companyId }),
      Vehicle.countDocuments({ company: companyId }),
      Rental.aggregate([
        {
          $match: {
            createdAt: { $gte: startDate, $lte: endDate },
            company: new mongoose.Types.ObjectId(companyId),
          },
        },
        { $group: { _id: null, totalRentalSales: { $sum: "$totalAmount" } } },
      ]),
      Expense.aggregate([
        { $match: matchCondition },
        { $group: { _id: null, totalExpenses: { $sum: "$amount" } } },
      ]),
    ]);

    return {
      revenue: 0,
      sales: salesData[0]?.totalSales || 0,
      drivers: driversCount,
      customers: customersCount,
      vehicles: vehiclesCount,
      rentalSales: rentalSalesData[0]?.totalRentalSales || 0,
      expenses: expensesData[0]?.totalExpenses || 0,
    };
  }
}
