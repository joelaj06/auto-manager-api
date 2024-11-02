import { RequestQuery, IDashboardSummaryData } from "../../../../../entities";

export interface IDashboardRepository {
  getDashboardSummaryData(query: RequestQuery): Promise<IDashboardSummaryData>;
}
