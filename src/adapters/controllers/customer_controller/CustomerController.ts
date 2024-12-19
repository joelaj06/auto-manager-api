import { inject, injectable } from "inversify";
import { ICustomerInteractor } from "../../../application/interactors";
import { NextFunction, Request, Response } from "express";
import { INTERFACE_TYPE, HttpStatusCode } from "../../../utils";
import { ControllerUserRequest } from "../auth_controller/IController";
import { BadRequestError } from "../../../error_handler";
import { RequestQuery } from "../../../entities";

@injectable()
export class CustomerController {
  private customerInteractor: ICustomerInteractor;

  constructor(
    @inject(INTERFACE_TYPE.CustomerInteractorImpl)
    customerInteractor: ICustomerInteractor
  ) {
    this.customerInteractor = customerInteractor;
  }

  async saveCustomer(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const data = {
        ...req.body,
        createdBy: req.user,
        company: req.user?.company || req.body.companyId,
      };
      if (!data.company) throw new BadRequestError("CompanyId is required");
      const result = await this.customerInteractor.saveCustomer(data);
      if (!result) throw new BadRequestError("Error while saving customer");
      res.status(HttpStatusCode.OK).json(result);
    } catch (error) {
      next(error);
    }
  }

  async getAllCustomers(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const query: RequestQuery = {
        search: req.query.search ? req.query.search.toString() : undefined,
        pageIndex: req.query.pageIndex
          ? Number(req.query.pageIndex)
          : undefined,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
        companyId: req.user?.company,
      };
      const response = await this.customerInteractor.getAllCustomers(query);
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

  async getACustomer(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      if (!id) throw new BadRequestError("Id is required");
      const result = await this.customerInteractor.getACustomer(id);
      if (!result) throw new BadRequestError("Error while getting customer");
      res.status(HttpStatusCode.OK).json(result);
    } catch (error) {
      next(error);
    }
  }

  async updateCustomer(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const { id } = req.params;
      if (!id) throw new BadRequestError("Id is required");
      const data = {
        ...req.body,
        updatedBy: req.user,
      };
      const result = await this.customerInteractor.updateCustomer(id, data);
      if (!result) throw new BadRequestError("Error while updating customer");
      res.status(HttpStatusCode.OK).json(result);
    } catch (error) {
      next(error);
    }
  }

  async deleteCustomer(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const { id } = req.params;
      if (!id) throw new BadRequestError("Id is required");
      const result = await this.customerInteractor.deleteCustomer(id);
      if (!result) throw new BadRequestError("Error while deleting customer");
      res.status(HttpStatusCode.OK).json(result);
    } catch (error) {
      next(error);
    }
  }
}
