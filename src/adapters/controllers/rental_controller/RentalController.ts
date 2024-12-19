import { inject, injectable } from "inversify";
import { HttpStatusCode, INTERFACE_TYPE } from "../../../utils";
import { IRentalInteractor } from "../../../application/interactors";
import { ControllerUserRequest } from "../auth_controller/IController";
import { NextFunction, Request, Response } from "express";
import {
  IRentalExtension,
  RentalRequestQuery,
  RequestQuery,
} from "../../../entities";
import { BadRequestError } from "../../../error_handler";

@injectable()
export class RentalController {
  private rentalInteractor: IRentalInteractor;

  constructor(
    @inject(INTERFACE_TYPE.RentalInteractorImpl)
    rentalInteractor: IRentalInteractor
  ) {
    this.rentalInteractor = rentalInteractor;
  }

  async removeExtension(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const { id } = req.params;
      if (!id) throw new BadRequestError("Rental id is required");
      const response = await this.rentalInteractor.removeExtension(
        id,
        req.body.indexes
      );
      return res.status(HttpStatusCode.OK).json(response);
    } catch (error) {
      next(error);
    }
  }
  async extendRental(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const { id } = req.params;

      if (!id) throw new BadRequestError("Rental id is required");

      const body: IRentalExtension = {
        ...req.body,
        extendedBy: req.user?._id,
      };
      const response = await this.rentalInteractor.extendRental(id, body);
      return res.status(HttpStatusCode.OK).json(response);
    } catch (error) {
      next(error);
    }
  }

  async getAllRentals(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const query: RentalRequestQuery = {
        search: req.query.search ? req.query.search.toString() : undefined,
        pageIndex: req.query.pageIndex
          ? Number(req.query.pageIndex)
          : undefined,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
        companyId: req.user?.company,
      };
      const response = await this.rentalInteractor.getAllRentals(query);
      res.set({
        "x-pagination": JSON.stringify({
          totalPages: response.totalPages,
          pageCount: response.pageCount,
          totalCount: response.totalCount,
        }),
        _meta_total_rentals: response.totalSum,
      });
      return res.status(HttpStatusCode.OK).json(response.data);
    } catch (error) {
      next(error);
    }
  }

  async addRental(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      //TODO add validation
      const data = {
        ...req.body,
        createdBy: req.user,
        company: req.user?.company || req.body.companyId,
      };

      if (!data.company) throw new BadRequestError("CompanyId is required");

      const response = await this.rentalInteractor.addRental(data);
      if (!response) throw new BadRequestError("Error while adding vehicle");
      return res.status(HttpStatusCode.OK).json(response);
    } catch (error) {
      next(error);
    }
  }

  async getARental(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      if (!id) throw new BadRequestError("Rental id is required");
      const response = await this.rentalInteractor.getARental(id);
      return res.status(HttpStatusCode.OK).json(response);
    } catch (error) {
      next(error);
    }
  }

  async updateRental(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const { id } = req.params;
      if (!id) throw new BadRequestError("Rental id is required");
      const body = {
        ...req.body,
        updatedBy: req.user?._id,
      };
      const response = await this.rentalInteractor.updateRental(id, body);
      return res.status(HttpStatusCode.OK).json(response);
    } catch (error) {
      next(error);
    }
  }

  async deleteRental(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const { id } = req.params;
      if (!id) throw new BadRequestError("Rental id is required");
      const response = await this.rentalInteractor.deleteRental(id);
      return res.status(HttpStatusCode.OK).json(response);
    } catch (error) {
      next(error);
    }
  }
}
