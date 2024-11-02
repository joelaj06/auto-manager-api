import { inject, injectable } from "inversify";
import { IDashboardInteractor } from "./IDashboardInteractor";
import {
  RequestQuery,
  IDashboardSummaryData,
  DashboardRequestQery,
  IMonthlySales,
} from "../../../entities";
import { INTERFACE_TYPE } from "../../../utils";
import { IDashboardRepository, ISalesRepository } from "../../../frameworks";
import { BadRequestError } from "../../../error_handler";

@injectable()
export class DashboardInteractorImpl implements IDashboardInteractor {
  private salesRepository: ISalesRepository;
  private dashboardRepository: IDashboardRepository;
  constructor(
    @inject(INTERFACE_TYPE.SalesRepositoryImpl)
    salesRepository: ISalesRepository,
    @inject(INTERFACE_TYPE.DashboardRepositoryImpl)
    dashboardRepository: IDashboardRepository
  ) {
    this.salesRepository = salesRepository;
    this.dashboardRepository = dashboardRepository;
  }
  async getDashboardSummaryData(
    query: RequestQuery
  ): Promise<IDashboardSummaryData> {
    if (!query.companyId) throw new BadRequestError("Company is required");
    const summaryData = await this.dashboardRepository.getDashboardSummaryData(
      query
    );
    if (!summaryData) throw new BadRequestError("Error while fetching data.");

    // Calculate revenue
    const revenue =
      summaryData.sales + summaryData.rentalSales - summaryData.expenses;
    const resData = { ...summaryData, revenue };
    return resData;
  }
  async getMonthlySalesData(
    query: DashboardRequestQery
  ): Promise<IMonthlySales> {
    const { month, year, company } = query;
    if (!company || !month || !year) {
      throw new BadRequestError("Month, Year, and Company is required");
    }

    const data = await this.salesRepository.getMonthlySales(query);

    if (!data) throw new BadRequestError("Error while fetching data.");

    // Initializing the expected weeks and sales arrays

    const formattedDates = [1, 2, 3, 4];
    const formattedSales = [0, 0, 0, 0];

    data.weeks.forEach((week, index) => {
      const salesValue = data.sales[index];
      formattedSales[week - 1] = salesValue; // -1 to match zero-based index
    });

    const formattedData: IMonthlySales = {
      weeks: formattedDates,
      sales: formattedSales,
    };
    return formattedData;
  }
}
