import express from "express";
import { Container } from "inversify";
import { INTERFACE_TYPE, Permissions } from "../../../utils";
import { AuthServiceImpl } from "../../services";
import { IAuthService } from "../../services/auth/IAuthService";
import { AuthMiddleware } from "../middleware/AuthMiddleware";
import {
  DashboardInteractorImpl,
  IDashboardInteractor,
} from "../../../application/interactors";
import { DashboardController } from "../../../adapters/controllers/dashboard_controller/DashboardController";
import { ISalesRepository } from "../../database/mongodb/repositories/sales/ISalesRepository";
import {
  DashboardRepositoryImpl,
  IDashboardRepository,
  SalesRepositoryImpl,
} from "../../database/mongodb/repositories";

const app = express();
const container = new Container();

container
  .bind<IAuthService>(INTERFACE_TYPE.AuthServiceImpl)
  .to(AuthServiceImpl);

container
  .bind<AuthMiddleware>(INTERFACE_TYPE.AuthMiddleware)
  .to(AuthMiddleware);

container
  .bind<ISalesRepository>(INTERFACE_TYPE.SalesRepositoryImpl)
  .to(SalesRepositoryImpl);

container
  .bind<IDashboardRepository>(INTERFACE_TYPE.DashboardRepositoryImpl)
  .to(DashboardRepositoryImpl);

container
  .bind<IDashboardInteractor>(INTERFACE_TYPE.DashboardInteractorImpl)
  .to(DashboardInteractorImpl);

container
  .bind<DashboardController>(INTERFACE_TYPE.DashboardController)
  .to(DashboardController);

const authMiddleware = container.get<AuthMiddleware>(
  INTERFACE_TYPE.AuthMiddleware
);

const controller = container.get<DashboardController>(
  INTERFACE_TYPE.DashboardController
);

const router = express.Router();

router.get(
  "/api/dashboard/monthlySales",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware
    .checkPermission(Permissions.VIEW_DASHBOARD_WEEKLY_SALES)
    .bind(authMiddleware),
  controller.getMonthlySalesData.bind(controller)
);

router.get(
  "/api/dashboard/dashboardSummary",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware
    .checkPermission(Permissions.VIEW_DASHBOARD_SUMMARY)
    .bind(authMiddleware),
  controller.getDashboardSummary.bind(controller)
);

export default router;
