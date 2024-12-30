import { injectable, inject } from "inversify";
import { HttpStatusCode, INTERFACE_TYPE } from "../../../utils";
import { PermissionRepositoryImpl } from "../../../frameworks/database/mongodb/repositories/permission/PermissionRepositoryImpl";
import { IPermissionInteractor } from "../../../application/interactors";
import { PermissionInteractorImpl } from "../../../application/interactors/permission/PermissionInteractorImpl";
import { NextFunction, Response, Request } from "express";
import { UnauthorizedError } from "../../../error_handler";
import config from "../../../config/config";

@injectable()
export class PermissionController {
  private permissionInteractor: IPermissionInteractor;
  constructor(
    @inject(INTERFACE_TYPE.PermissionInteractorImpl)
    permissionInteractor: PermissionInteractorImpl
  ) {
    this.permissionInteractor = permissionInteractor;
  }

  async getAllPermissions(req: Request, res: Response, next: NextFunction) {
    try {
      const response = await this.permissionInteractor.getAllPermissions();
      return res.status(HttpStatusCode.OK).json(response);
    } catch (error) {
      next(error);
    }
  }

  async uploadPermissions(req: Request, res: Response, next: NextFunction) {
    try {
      const key = req.query.key;
      if (!key) throw new UnauthorizedError("key is required");
      if (key !== config.permissionKey)
        throw new UnauthorizedError("Invalid key");
      const response = await this.permissionInteractor.uploadPermissions();
      return res.status(HttpStatusCode.NO_CONTENT).json(response);
    } catch (error) {
      next(error);
    }
  }
}
