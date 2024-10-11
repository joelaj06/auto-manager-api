import { inject, injectable } from "inversify";
import { ISalesInteractor } from "../../../application/interactors/sales/ISalesInteractor";
import { HttpStatusCode, INTERFACE_TYPE } from "../../../utils";

import { NextFunction, Request, Response } from "express";
import { RequestQuery } from "../../../entities";
import { BadRequestError } from "../../../error_handler";
import { ControllerUserRequest } from "../auth_controller/IController";

@injectable()
export class SalesController {
  private salesInteractor: ISalesInteractor;

  constructor(
    @inject(INTERFACE_TYPE.SalesInteractorImpl)
    salesInteractor: ISalesInteractor
  ) {
    this.salesInteractor = salesInteractor;
  }

  async getAllSales(req: Request, res: Response, next: NextFunction) {
    try {
      //TODO query data by company id
      const query: RequestQuery = {
        search: req.query.search ? req.query.search.toString() : undefined,
        pageIndex: req.query.pageIndex
          ? Number(req.query.pageIndex)
          : undefined,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
      };
      const response = await this.salesInteractor.getAllSales(query);
      res.set(
        "x-pagination",
        JSON.stringify({
          totalPages: response.totalPages,
          pageCount: response.pageCount,
          totalCount: response.totalCount,
        })
      );
      return res.status(HttpStatusCode.OK).json(response.data);
    } catch (error) {
      next(error);
    }
  }

  async addSale(req: ControllerUserRequest, res: Response, next: NextFunction) {
    try {
      //TODO add validation
      const data = {
        ...req.body,
        createdBy: req.user,
        companyId: req.user?.company,
      };
      const sale = await this.salesInteractor.addSale(data);
      if (!sale) throw new BadRequestError("Error while adding sale");
      return res.status(HttpStatusCode.CREATED).json(sale);
    } catch (error) {
      next(error);
    }
  }

  async getASale(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      if (!id) throw new BadRequestError("Sale id is required");
      const sale = await this.salesInteractor.getASale(id);
      return res.status(HttpStatusCode.OK).json(sale);
    } catch (error) {
      next(error);
    }
  }

  async updateSale(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const sale = await this.salesInteractor.updateSale(id, req.body);
      if (!sale) throw new BadRequestError("Error while updating sale");
      return res.status(HttpStatusCode.OK).json(sale);
    } catch (error) {
      next(error);
    }
  }

  async deleteSale(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      if (!id) throw new BadRequestError("Sale id is required");
      const sale = await this.salesInteractor.deleteSale(id);
      if (!sale) throw new BadRequestError("Error while deleting sale");
      return res.status(HttpStatusCode.NO_CONTENT).json();
    } catch (error) {
      next(error);
    }
  }
}
