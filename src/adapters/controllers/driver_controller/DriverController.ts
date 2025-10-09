import { inject, injectable } from "inversify";
import { IDriverInteractor } from "../../../application/interactors";
import { HttpStatusCode, INTERFACE_TYPE } from "../../../utils";
import { NextFunction, Request, Response } from "express";
import { RequestQuery, UserRequest } from "../../../entities";
import { BadRequestError } from "../../../error_handler";
import { ControllerUserRequest } from "../auth_controller/IController";

@injectable()
export class DriverController {
  public driverInteractor: IDriverInteractor;

  constructor(
    @inject(INTERFACE_TYPE.DriverInteractorImpl)
    driverInteractor: IDriverInteractor
  ) {
    this.driverInteractor = driverInteractor;
  }

  async getAllDrivers(
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

      const response = await this.driverInteractor.getAllDrivers(query);
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

  async getADriver(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      if (!id) throw new BadRequestError("Vehicle id is required");
      const vehicle = await this.driverInteractor.getADriver(id);
      return res.status(HttpStatusCode.OK).json(vehicle);
    } catch (error) {
      next(error);
    }
  }

  async updateDriver(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const driver = await this.driverInteractor.updateDriver(id, req.body);
      if (!driver) throw new BadRequestError("Error while updating driver");
      return res.status(HttpStatusCode.OK).json(driver);
    } catch (error) {
      next(error);
    }
  }

  async deleteDriver(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      if (!id) throw new BadRequestError("Driver id is required");
      const driver = await this.driverInteractor.deleteDriver(id);
      if (!driver) throw new BadRequestError("Error while deleting driver");
      return res.status(HttpStatusCode.NO_CONTENT).json();
    } catch (error) {
      next(error);
    }
  }

  async addDriver(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      //retrive company id from logged in user
      if (req.user && req.user.company) {
        req.body.company = req.user.company;
        req.body.vehicle = req.body.vehicleId;
      }
      const driver = await this.driverInteractor.addDriver(req.body);
      if (!driver) throw new BadRequestError("Error while adding driver");
      // find driver by id and populate vehicle
      const populatedDriver = await this.driverInteractor.getADriver(
        driver._id!
      );
      return res.status(HttpStatusCode.CREATED).json(populatedDriver);
    } catch (error) {
      next(error);
    }
  }
}
