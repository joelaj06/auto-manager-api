import { Container } from "inversify";
import { INTERFACE_TYPE } from "../../../utils/constants";
import { IAuthService } from "../../services/auth/IAuthService";
import { AuthServiceImpl } from "../../services";
import { AuthMiddleware } from "../middleware/AuthMiddleware";
import { RentalController } from "../../../adapters/controllers/rental_controller/RentalController";
import {
  IRentalInteractor,
  RentalInteractorImpl,
} from "../../../application/interactors";
import {
  IRentalRepository,
  RentalRepositoryImpl,
} from "../../database/mongodb";
import express from "express";

const container = new Container();

container
  .bind<IAuthService>(INTERFACE_TYPE.AuthServiceImpl)
  .to(AuthServiceImpl);

container
  .bind<AuthMiddleware>(INTERFACE_TYPE.AuthMiddleware)
  .to(AuthMiddleware);

//repository
container
  .bind<IRentalRepository>(INTERFACE_TYPE.RentalRepositoryImpl)
  .to(RentalRepositoryImpl);

container
  .bind<IRentalInteractor>(INTERFACE_TYPE.RentalInteractorImpl)
  .to(RentalInteractorImpl);

container
  .bind<RentalController>(INTERFACE_TYPE.RentalController)
  .to(RentalController);

const controller = container.get<RentalController>(
  INTERFACE_TYPE.RentalController
);
const authMiddleware = container.get<AuthMiddleware>(
  INTERFACE_TYPE.AuthMiddleware
);

const router = express.Router();

router.get(
  "/api/rentals",
  authMiddleware.authenticateToken.bind(authMiddleware),
  controller.getAllRentals.bind(controller)
);
router.post(
  "/api/rentals",
  authMiddleware.authenticateToken.bind(authMiddleware),
  controller.addRental.bind(controller)
);
router.get(
  "/api/rentals/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  controller.getARental.bind(controller)
);
router.put(
  "/api/rentals/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  controller.updateRental.bind(controller)
);
router.delete(
  "/api/rentals/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  controller.deleteRental.bind(controller)
);

router.put(
  "/api/rentals/:id/extend",
  authMiddleware.authenticateToken.bind(authMiddleware),
  controller.extendRental.bind(controller)
);

export default router;
