import { inject, injectable } from "inversify";
import { IDashboardInteractor } from "../../../application/interactors";
import { INTERFACE_TYPE } from "../../../utils";
import { NextFunction, Request, Response } from "express";
import { BadRequestError } from "../../../error_handler";

@injectable()
export class DashboardController {
  private dashboardInteractor: IDashboardInteractor;
  constructor(
    @inject(INTERFACE_TYPE.DashboardInteractorImpl)
    dashboardInteractor: IDashboardInteractor
  ) {
    this.dashboardInteractor = dashboardInteractor;
  }

  async getMonthlySalesData(req: Request, res: Response, next: NextFunction) {
    try {
      const { month, year, company } = req.query;
      if (!month || !year || !company)
        throw new BadRequestError(
          "All fields are required - month, year, company"
        );
      const data = await this.dashboardInteractor.getMonthlySalesData({
        month: Number(month),
        year: Number(year),
        company: company.toString(),
      });
      res.status(200).json(data);
    } catch (error) {
      next(error);
    }
  }
}
