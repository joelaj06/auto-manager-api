import { inject, injectable } from "inversify";
import { ICompanyInteractor } from "../../../application/interactors";
import { HttpStatusCode, INTERFACE_TYPE } from "../../../utils";
import { NextFunction, Request, Response } from "express";
import { BadRequestError } from "../../../error_handler";
import { ControllerUserRequest } from "../auth_controller/IController";

@injectable()
export class CompanyController {
  private companyInteractor: ICompanyInteractor;
  constructor(
    @inject(INTERFACE_TYPE.CompanyInteractorImpl)
    companyInteractor: ICompanyInteractor
  ) {
    this.companyInteractor = companyInteractor;
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
