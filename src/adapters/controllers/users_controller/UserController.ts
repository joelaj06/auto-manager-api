import { inject, injectable } from "inversify";
import { IUserInteractor } from "../../../application/interactors/users/IUserInteractor";
import { HttpStatusCode, INTERFACE_TYPE } from "../../../utils";
import { NextFunction, Request, Response } from "express";
import { IUser, RequestQuery } from "../../../entities/User";
import { ControllerUserRequest } from "../auth_controller/IController";
import { BadRequestError } from "../../../error_handler";

@injectable()
export class UserController {
  private userInteractor: IUserInteractor;
  constructor(
    @inject(INTERFACE_TYPE.UserInteractor) userInteractor: IUserInteractor
  ) {
    this.userInteractor = userInteractor;
  }

  async getAUser(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const response = await this.userInteractor.getAUser(id);
      return res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }
  async deleteUser(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;

      const response = await this.userInteractor.deleteUser(id);
      if (!response) throw new BadRequestError("Error deleting user");
      return res.status(HttpStatusCode.NO_CONTENT).json();
    } catch (error) {
      next(error);
    }
  }
  async addUser(req: ControllerUserRequest, res: Response, next: NextFunction) {
    try {
      //TODO add validation
      const createdBy = req.user?._id;
      const response = await this.userInteractor.addUser({
        ...req.body,
        company: req.user?.company,
        createdBy,
      });
      return res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }
  async getAllUsers(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const query: RequestQuery = {
        companyId: req.user?.company,
        search: req.query.search ? req.query.search.toString() : undefined,
        pageIndex: req.query.pageIndex
          ? Number(req.query.pageIndex)
          : undefined,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
      };
      const response = await this.userInteractor.getAllUsers(query);
      res.set(
        "x-pagination",
        JSON.stringify({
          totalPages: response.totalPages,
          pageCount: response.pageCount,
          totalCount: response.totalCount,
        })
      );
      return res.status(200).json(response.data);
    } catch (error) {
      next(error);
    }
  }
  async updateUser(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const response = await this.userInteractor.updateUser(id, req.body);
      return res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }
}
