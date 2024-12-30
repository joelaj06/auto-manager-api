import { Container } from "inversify";
import { AuthMiddleware } from "../middleware/AuthMiddleware";
import { INTERFACE_TYPE, Permissions } from "../../../utils";
import { DriverController } from "../../../adapters/controllers/driver_controller/DriverController";
import { IAuthService } from "../../services/auth/IAuthService";
import { AuthServiceImpl } from "../../services";

import {
  DriverInteractorImpl,
  IDriverInteractor,
} from "../../../application/interactors";
import express from "express";
import {
  DriverRepositoryImpl,
  IDriverRepository,
} from "../../database/mongodb";

const container = new Container();

container
  .bind<IDriverRepository>(INTERFACE_TYPE.DriverRepositoryImpl)
  .to(DriverRepositoryImpl);

container
  .bind<IDriverInteractor>(INTERFACE_TYPE.DriverInteractorImpl)
  .to(DriverInteractorImpl);

container
  .bind<IAuthService>(INTERFACE_TYPE.AuthServiceImpl)
  .to(AuthServiceImpl);

container
  .bind<AuthMiddleware>(INTERFACE_TYPE.AuthMiddleware)
  .to(AuthMiddleware);

container
  .bind<DriverController>(INTERFACE_TYPE.DriverController)
  .to(DriverController);

const controller = container.get<DriverController>(
  INTERFACE_TYPE.DriverController
);

const authMiddleware = container.get<AuthMiddleware>(
  INTERFACE_TYPE.AuthMiddleware
);

const router = express.Router();

router.get(
  "/api/drivers",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware.checkPermission(Permissions.VIEW_DRIVERS).bind(authMiddleware),
  controller.getAllDrivers.bind(controller)
);

router.get(
  "/api/drivers/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware.checkPermission(Permissions.VIEW_DRIVER).bind(authMiddleware),
  controller.getADriver.bind(controller)
);
router.put(
  "/api/drivers/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware
    .checkPermission(Permissions.UPDATE_DRIVER)
    .bind(authMiddleware),
  controller.updateDriver.bind(controller)
);

router.delete(
  "/api/drivers/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware
    .checkPermission(Permissions.DELETE_DRIVER)
    .bind(authMiddleware),
  controller.deleteDriver.bind(controller)
);

export default router;
