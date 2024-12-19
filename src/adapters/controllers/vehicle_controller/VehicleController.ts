import { inject, injectable } from "inversify";
import { HttpStatusCode, INTERFACE_TYPE } from "../../../utils";
import { IVehicleInteractor } from "../../../application/interactors";
import { IVehicleRepository } from "../../../frameworks";
import { RequestQuery } from "../../../entities";
import { NextFunction, Request, Response } from "express";
import { ControllerUserRequest } from "../auth_controller/IController";
import { BadRequestError } from "../../../error_handler";

@injectable()
export class VehicleController {
  private vehicleInteractor: IVehicleInteractor;

  constructor(
    @inject(INTERFACE_TYPE.VehicleInteractorImpl)
    vehicleInteractor: IVehicleInteractor
  ) {
    this.vehicleInteractor = vehicleInteractor;
  }

  async getAllVehicles(
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
      const response = await this.vehicleInteractor.getAllVehicles(query);
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

  async addVehicle(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      //TODO add validation
      const data = {
        ...req.body,
        createdBy: req.user,
        ownerId: req.user?.company,
        companyId: req.user?.company,
        company: req.user?.company,
      };

      if (!data.company) throw new BadRequestError("CompanyId is required");

      const vehicle = await this.vehicleInteractor.addVehicle(data);
      if (!vehicle) throw new BadRequestError("Error while adding vehicle");
      return res.status(HttpStatusCode.CREATED).json(vehicle);
    } catch (error) {
      next(error);
    }
  }

  async getAVehicle(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      if (!id) throw new BadRequestError("Vehicle id is required");
      const vehicle = await this.vehicleInteractor.getAVehicle(id);
      return res.status(HttpStatusCode.OK).json(vehicle);
    } catch (error) {
      next(error);
    }
  }

  async updateVehicle(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const vehicle = await this.vehicleInteractor.updateVehicle(id, req.body);
      if (!vehicle) throw new BadRequestError("Error while updating vehicle");
      return res.status(HttpStatusCode.OK).json(vehicle);
    } catch (error) {
      next(error);
    }
  }

  async deleteVehicle(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      if (!id) throw new BadRequestError("Vehicle id is required");
      const vehicle = await this.vehicleInteractor.deleteVehicle(id);
      if (!vehicle) throw new BadRequestError("Error while deleting vehicle");
      return res.status(HttpStatusCode.NO_CONTENT).json();
    } catch (error) {
      next(error);
    }
  }
}
