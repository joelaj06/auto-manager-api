import { inject, injectable } from "inversify";
import { ICompanyInteractor } from "../../../application/interactors";
import { HttpStatusCode, INTERFACE_TYPE } from "../../../utils";
import { NextFunction, Request, Response } from "express";
import { BadRequestError } from "../../../error_handler";
import { ControllerUserRequest } from "../auth_controller/IController";
import { RequestQuery } from "../../../entities";

@injectable()
export class CompanyController {
  private companyInteractor: ICompanyInteractor;
  constructor(
    @inject(INTERFACE_TYPE.CompanyInteractorImpl)
    companyInteractor: ICompanyInteractor
  ) {
    this.companyInteractor = companyInteractor;
  }

  async updateCompany(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const response = await this.companyInteractor.updateCompany(id, req.body);
      return res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }
  async getACompany(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      if (!id) throw new BadRequestError("Company id is required");
      const company = await this.companyInteractor.getACompany(id);
      return res.status(HttpStatusCode.OK).json(company);
    } catch (error) {
      next(error);
    }
  }
  async getAllCompanies(req: Request, res: Response, next: NextFunction) {
    try {
      const query: RequestQuery = {
        search: req.query.search ? req.query.search.toString() : undefined,
        pageIndex: req.query.pageIndex
          ? Number(req.query.pageIndex)
          : undefined,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
      };
      const response = await this.companyInteractor.getAllCompanies(query);
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
  async addCompany(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      //TODO add validation
      const data = { ...req.body, createdBy: req.user };
      const company = await this.companyInteractor.addCompany(data);
      if (!company) throw new BadRequestError("Error while adding company");
      res.status(HttpStatusCode.CREATED).json(company);
    } catch (error) {
      next(error);
    }
  }
}
