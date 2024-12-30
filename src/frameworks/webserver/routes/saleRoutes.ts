import express from "express";
import { Container } from "inversify";
import {
  ISalesRepository,
  SalesRepositoryImpl,
} from "../../database/mongodb/repositories/sales";
import { INTERFACE_TYPE, Permissions } from "../../../utils";
import {
  IAuthInteractor,
  ISalesInteractor,
  SalesInteractorImpl,
} from "../../../application/interactors";
import { IAuthService } from "../../services/auth/IAuthService";
import { AuthServiceImpl } from "../../services";
import { AuthMiddleware } from "../middleware/AuthMiddleware";
import { SalesController } from "../../../adapters/controllers/sales_controller/SalesController";

const container = new Container();

container
  .bind<ISalesRepository>(INTERFACE_TYPE.SalesRepositoryImpl)
  .to(SalesRepositoryImpl);

container
  .bind<ISalesInteractor>(INTERFACE_TYPE.SalesInteractorImpl)
  .to(SalesInteractorImpl);

container
  .bind<IAuthService>(INTERFACE_TYPE.AuthServiceImpl)
  .to(AuthServiceImpl);

container
  .bind<AuthMiddleware>(INTERFACE_TYPE.AuthMiddleware)
  .to(AuthMiddleware);

container
  .bind<SalesController>(INTERFACE_TYPE.SalesController)
  .to(SalesController);

const controller = container.get<SalesController>(
  INTERFACE_TYPE.SalesController
);

const authMiddleware = container.get<AuthMiddleware>(
  INTERFACE_TYPE.AuthMiddleware
);

const router = express.Router();

router.get(
  "/api/sales",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware.checkPermission(Permissions.VIEW_SALES).bind(authMiddleware),
  controller.getAllSales.bind(controller)
);

router.get(
  "/api/sales/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware.checkPermission(Permissions.VIEW_SALE).bind(authMiddleware),
  controller.getASale.bind(controller)
);

router.post(
  "/api/sales",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware.checkPermission(Permissions.CREATE_SALE).bind(authMiddleware),
  controller.addSale.bind(controller)
);

router.put(
  "/api/sales/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware.checkPermission(Permissions.UPDATE_SALE).bind(authMiddleware),
  controller.updateSale.bind(controller)
);

router.delete(
  "/api/sales/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware.checkPermission(Permissions.DELETE_SALE).bind(authMiddleware),
  controller.deleteSale.bind(controller)
);

export default router;
