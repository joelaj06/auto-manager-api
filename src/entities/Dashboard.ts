import { RequestQuery } from "./User";

export class IMonthlySales {
  constructor(public weeks: number[], public sales: number[]) {}
}

export class IDashboardSummaryData {
  constructor(
    public sales: number,
    public drivers: number,
    public customers: number,
    public vehicles: number,
    public rentalSales: number,
    public expenses: number,
    public revenue: number
  ) {}
}

export interface DashboardRequestQery extends RequestQuery {
  month: number;
  year: number;
  company: string;
}
