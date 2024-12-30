import express from "express";
import { Container } from "inversify";
import { INTERFACE_TYPE, Permissions } from "../../../utils";
import { AuthMiddleware } from "../middleware/AuthMiddleware";
import { AuthServiceImpl } from "../../services";
import { IAuthService } from "../../services/auth/IAuthService";
import {
  IPermissionRepository,
  PermissionRepositoryImpl,
} from "../../database/mongodb";
import { PermissionInteractorImpl } from "../../../application/interactors/permission/PermissionInteractorImpl";
import { IPermissionInteractor } from "../../../application/interactors";
import { PermissionController } from "../../../adapters/controllers/permission_controller/PermissionController";
import { ILogger, LoggerImpl } from "../../logging";

const container = new Container();

container.bind<ILogger>(INTERFACE_TYPE.Logger).to(LoggerImpl);

container
  .bind<IAuthService>(INTERFACE_TYPE.AuthServiceImpl)
  .to(AuthServiceImpl);

container
  .bind<AuthMiddleware>(INTERFACE_TYPE.AuthMiddleware)
  .to(AuthMiddleware);

container
  .bind<IPermissionRepository>(INTERFACE_TYPE.PermissionRepositoryImpl)
  .to(PermissionRepositoryImpl);

container
  .bind<IPermissionInteractor>(INTERFACE_TYPE.PermissionInteractorImpl)
  .to(PermissionInteractorImpl);

container
  .bind<PermissionController>(PermissionController)
  .to(PermissionController);

const controller = container.get<PermissionController>(PermissionController);

const authMiddleware = container.get<AuthMiddleware>(
  INTERFACE_TYPE.AuthMiddleware
);

const router = express.Router();

router.get(
  "/api/permissions",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware
    .checkPermission(Permissions.VIEW_PERMISSIONS)
    .bind(authMiddleware),
  controller.getAllPermissions.bind(controller)
);

router.post("/api/permissions", controller.uploadPermissions.bind(controller));

export default router;
