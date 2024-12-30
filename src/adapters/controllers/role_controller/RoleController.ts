import { inject, injectable } from "inversify";
import { IRoleInteractor } from "../../../application/interactors";
import { HttpStatusCode, INTERFACE_TYPE } from "../../../utils";
import { ControllerUserRequest } from "../auth_controller/IController";
import { NextFunction, Response, Request } from "express";
import { BadRequestError } from "../../../error_handler";
import { RequestQuery } from "../../../entities";

@injectable()
export class RoleController {
  private roleInteractor: IRoleInteractor;

  constructor(
    @inject(INTERFACE_TYPE.RoleInteractorImpl) roleInteractor: IRoleInteractor
  ) {
    this.roleInteractor = roleInteractor;
  }

  async addRole(req: ControllerUserRequest, res: Response, next: NextFunction) {
    try {
      const data = {
        ...req.body,
        companyId: req.user?.company,
      };
      if (!data.companyId) throw new BadRequestError("CompanyId is required");

      const role = await this.roleInteractor.addRole(data);
      if (!role) throw new BadRequestError("Error while adding role");
      return res.status(HttpStatusCode.CREATED).json(role);
    } catch (error) {
      next(error);
    }
  }

  async getARole(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const response = await this.roleInteractor.getARole(id);
      if (!response) throw new BadRequestError("Error while getting role");
      return res.status(HttpStatusCode.OK).json(response);
    } catch (error) {
      next(error);
    }
  }

  async getAllRoles(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const query: RequestQuery = {
        companyId: req.user?.company,
        search: req.query.search ? req.query.search.toString() : undefined,
      };
      const response = await this.roleInteractor.getRoles(query);
      if (!response) throw new BadRequestError("Error while getting roles");
      return res.status(HttpStatusCode.OK).json(response);
    } catch (error) {
      next(error);
    }
  }

  async updateRole(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const data = {
        name: req.body.name,
        description: req.body.description,
        permissions: req.body.permissions,
      };
      const response = await this.roleInteractor.updateRole(id, data);
      if (!response) throw new BadRequestError("Error while updating role");
      return res.status(HttpStatusCode.OK).json(response);
    } catch (error) {
      next(error);
    }
  }

  async deleteRole(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      if (!id) throw new BadRequestError("Role id is required");
      const response = await this.roleInteractor.deleteRole(id);
      if (!response) throw new BadRequestError("Error while deleting role");
      return res.status(HttpStatusCode.OK).json(response);
    } catch (error) {
      next(error);
    }
  }
}
