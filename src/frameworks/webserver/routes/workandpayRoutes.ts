import { Container } from "inversify";
import { INTERFACE_TYPE } from "../../../utils/constants";
import { AuthServiceImpl } from "../../services";
import { IAuthService } from "../../services/auth/IAuthService";
import { AuthMiddleware } from "../middleware";
import {
  IVehicleRepository,
  IWorkAndPayRepository,
  VehicleRepositoryImpl,
  WorkAndPayRepositoryImpl,
} from "../../database/mongodb";
import { RentalController } from "../../../adapters/controllers/rental_controller/RentalController";
import {
  IWorkAndPayInteractor,
  WorkAndPayInteractorImpl,
} from "../../../application/interactors";
import { WorkAndPayController } from "../../../adapters/controllers/workandpay_controller/WorkAndPayController";
import express from "express";

const container = new Container();

container
  .bind<IAuthService>(INTERFACE_TYPE.AuthServiceImpl)
  .to(AuthServiceImpl);

container
  .bind<AuthMiddleware>(INTERFACE_TYPE.AuthMiddleware)
  .to(AuthMiddleware);

container
  .bind<IVehicleRepository>(INTERFACE_TYPE.VehicleRepositoryImpl)
  .to(VehicleRepositoryImpl);

container
  .bind<IWorkAndPayRepository>(INTERFACE_TYPE.WorkAndPayRepositoryImpl)
  .to(WorkAndPayRepositoryImpl);

container
  .bind<IWorkAndPayInteractor>(INTERFACE_TYPE.WorkAndPayInteractorImpl)
  .to(WorkAndPayInteractorImpl);

container
  .bind<WorkAndPayController>(INTERFACE_TYPE.WorkAndPayController)
  .to(WorkAndPayController);

const controller = container.get<WorkAndPayController>(
  INTERFACE_TYPE.WorkAndPayController
);
const authMiddleware = container.get<AuthMiddleware>(
  INTERFACE_TYPE.AuthMiddleware
);

const router = express.Router();

router.post(
  "/api/work-pay/agreement",
  authMiddleware.authenticateToken.bind(authMiddleware),
  // authMiddleware.checkPermission("CREATE_WORK_AND_PAY").bind(authMiddleware),
  controller.initiateAgreement.bind(controller)
);

router.post(
  "/api/work-pay/payment",
  authMiddleware.authenticateToken.bind(authMiddleware),
  // authMiddleware.checkPermission("RECORD_PAYMENT").bind(authMiddleware),
  controller.recordPayment.bind(controller)
);

router.get(
  "/api/work-pay/agreement/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  // authMiddleware.checkPermission("VIEW_WORK_AND_PAY").bind(authMiddleware),
  controller.getAgreement.bind(controller)
);

router.get(
  "/api/work-pay/agreement/:id/payments",
  authMiddleware.authenticateToken.bind(authMiddleware),
  // authMiddleware.checkPermission("VIEW_WORK_AND_PAY_PAYMENTS").bind(authMiddleware),
  controller.getPaymentsByAgreement.bind(controller)
);

router.get(
  "/api/work-pay/agreement/:id/payments",
  authMiddleware.authenticateToken.bind(authMiddleware),
  // authMiddleware.checkPermission("VIEW_WORK_AND_PAY_PAYMENTS").bind(authMiddleware),
  controller.getPaymentsByAgreement.bind(controller)
);

export default router;
