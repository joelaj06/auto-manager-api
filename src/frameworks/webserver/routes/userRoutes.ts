import { Container } from "inversify";
import { IUserRepository, UserRepositoryImpl } from "../../database/mongodb";
import { INTERFACE_TYPE } from "../../../utils";
import { UserController } from "../../../adapters/controllers/users_controller/UserController";
import express from "express";
import { IAuthService } from "../../services/auth/IAuthService";
import {
  IUserInteractor,
  UserInteractorImpl,
} from "../../../application/interactors";
import { AuthServiceImpl } from "../../services";
import { AuthMiddleware } from "../middleware/AuthMiddleware";
import { IDriverRepository } from "../../database/mongodb/repositories/driver/IDriverRepository";
import { DriverRepositoryImpl } from "../../database/mongodb/repositories/driver/DriverRepositoryImpl";

const container = new Container();

container
  .bind<IUserRepository>(INTERFACE_TYPE.UserRepositoryImpl)
  .to(UserRepositoryImpl);

container
  .bind<IUserInteractor>(INTERFACE_TYPE.UserInteractor)
  .to(UserInteractorImpl);

container
  .bind<IDriverRepository>(INTERFACE_TYPE.DriverRepositoryImpl)
  .to(DriverRepositoryImpl);

container
  .bind<IAuthService>(INTERFACE_TYPE.AuthServiceImpl)
  .to(AuthServiceImpl);
container
  .bind<UserController>(INTERFACE_TYPE.UserController)
  .to(UserController);

container
  .bind<AuthMiddleware>(INTERFACE_TYPE.AuthMiddleware)
  .to(AuthMiddleware);

const controller = container.get<UserController>(INTERFACE_TYPE.UserController);
const authMiddleware = container.get<AuthMiddleware>(
  INTERFACE_TYPE.AuthMiddleware
);

const router = express.Router();

router.get(
  "/api/users",
  authMiddleware.authenticateToken.bind(authMiddleware),
  controller.getAllUsers.bind(controller)
);
router
  .route("/api/users/:id")
  .get(
    authMiddleware.authenticateToken.bind(authMiddleware),
    controller.getAUser.bind(controller)
  )
  .put(
    authMiddleware.authenticateToken.bind(authMiddleware),
    controller.updateUser.bind(controller)
  );
router.delete(
  "/api/users/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  controller.deleteUser.bind(controller)
);
router.post(
  "/api/users",
  authMiddleware.authenticateToken.bind(authMiddleware),
  controller.addUser.bind(controller)
);

export default router;
