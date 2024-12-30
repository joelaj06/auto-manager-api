import express from "express";
import { Container } from "inversify";
import {
  IVehicleRepository,
  VehicleRepositoryImpl,
} from "../../database/mongodb";
import { INTERFACE_TYPE, Permissions } from "../../../utils";
import {
  IVehicleInteractor,
  VehicleInteractorImpl,
} from "../../../application/interactors";
import { AuthMiddleware } from "../middleware/AuthMiddleware";
import { VehicleController } from "../../../adapters/controllers/vehicle_controller/VehicleController";
import { IAuthService } from "../../services/auth/IAuthService";
import {
  AuthServiceImpl,
  CloudinaryImpl,
  IStorageBucket,
} from "../../services";

const container = new Container();

container
  .bind<IVehicleRepository>(INTERFACE_TYPE.VehicleRepositoryImpl)
  .to(VehicleRepositoryImpl);

container
  .bind<IVehicleInteractor>(INTERFACE_TYPE.VehicleInteractorImpl)
  .to(VehicleInteractorImpl);

container
  .bind<IStorageBucket>(INTERFACE_TYPE.StorageBucketImpl)
  .to(CloudinaryImpl);

container
  .bind<IAuthService>(INTERFACE_TYPE.AuthServiceImpl)
  .to(AuthServiceImpl);

container
  .bind<AuthMiddleware>(INTERFACE_TYPE.AuthMiddleware)
  .to(AuthMiddleware);

container
  .bind<VehicleController>(INTERFACE_TYPE.VehicleController)
  .to(VehicleController);

const controller = container.get<VehicleController>(
  INTERFACE_TYPE.VehicleController
);

const authMiddleware = container.get<AuthMiddleware>(
  INTERFACE_TYPE.AuthMiddleware
);

const router = express.Router();

router.get(
  "/api/vehicles",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware
    .checkPermission(Permissions.VIEW_VEHICLES)
    .bind(authMiddleware),
  controller.getAllVehicles.bind(controller)
);
router.post(
  "/api/vehicles",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware
    .checkPermission(Permissions.CREATE_VEHICLE)
    .bind(authMiddleware),
  controller.addVehicle.bind(controller)
);
router.get(
  "/api/vehicles/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware.checkPermission(Permissions.VIEW_VEHICLE).bind(authMiddleware),
  controller.getAVehicle.bind(controller)
);
router.put(
  "/api/vehicles/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware
    .checkPermission(Permissions.UPDATE_VEHICLE)
    .bind(authMiddleware),
  controller.updateVehicle.bind(controller)
);
router.delete(
  "/api/vehicles/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware
    .checkPermission(Permissions.DELETE_VEHICLE)
    .bind(authMiddleware),
  controller.deleteVehicle.bind(controller)
);

export default router;
