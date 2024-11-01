import { inject, injectable } from "inversify";
import { IDashboardInteractor } from "./IDashboardInteractor";
import {
  RequestQuery,
  IDashboardSummaryData,
  DashboardRequestQery,
  IMonthlySales,
} from "../../../entities";
import { INTERFACE_TYPE } from "../../../utils";
import { ISalesRepository } from "../../../frameworks";
import { BadRequestError } from "../../../error_handler";

@injectable()
export class DashboardInteractorImpl implements IDashboardInteractor {
  private salesRepository;
  constructor(
    @inject(INTERFACE_TYPE.SalesRepositoryImpl)
    salesRepository: ISalesRepository
  ) {
    this.salesRepository = salesRepository;
  }
  async getDashboardSummaryData(
    query: RequestQuery
  ): Promise<IDashboardSummaryData> {
    throw new Error("Method not implemented.");
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
