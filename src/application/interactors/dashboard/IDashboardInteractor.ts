import {
  DashboardRequestQery,
  IDashboardSummaryData,
  IMonthlySales,
  RequestQuery,
} from "../../../entities";

export interface IDashboardInteractor {
  getDashboardSummaryData(query: RequestQuery): Promise<IDashboardSummaryData>;

  getMonthlySalesData(query: DashboardRequestQery): Promise<IMonthlySales>;
}
