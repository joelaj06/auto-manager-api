import express from "express";
import { AuthController } from "../../../adapters/controllers/auth_controller/AuthController";
import { AuthInteractorImpl } from "../../../application/interactors/index";

import { Container } from "inversify";
import { IAuthRepository } from "../../database/mongodb/repositories/auth/IAuthRepository";
import { INTERFACE_TYPE } from "../../../utils/constants";

import { AuthServiceImpl, MailerImpl } from "../../services/index";

import {
  UserRepositoryImpl,
  AuthRepositoryImpl,
} from "../../database/mongodb/repositories/index";
import { IAuthInteractor } from "../../../application/interactors/auth/IAuthInteractor";
import { IUserRepository } from "../../database/mongodb/repositories/user/IUserRepository";
import { IAuthService } from "../../services/auth/IAuthService";
import { IMailer } from "../../services/mailer/IMailer";
import { AuthMiddleware } from "../middleware/AuthMiddleware";

const container = new Container();
container
  .bind<IAuthRepository>(INTERFACE_TYPE.AuthRepositoryImpl)
  .to(AuthRepositoryImpl);
container
  .bind<IAuthService>(INTERFACE_TYPE.AuthServiceImpl)
  .to(AuthServiceImpl);
container
  .bind<IAuthInteractor>(INTERFACE_TYPE.AuthInteractorImpl)
  .to(AuthInteractorImpl);
container
  .bind<AuthController>(INTERFACE_TYPE.AuthController)
  .to(AuthController);

container
  .bind<IUserRepository>(INTERFACE_TYPE.UserRepositoryImpl)
  .to(UserRepositoryImpl);

container.bind<IMailer>(INTERFACE_TYPE.Mailer).to(MailerImpl);

container
  .bind<AuthMiddleware>(INTERFACE_TYPE.AuthMiddleware)
  .to(AuthMiddleware);

// Create a new instance of the controller and bind it to the router.
const controller = container.get<AuthController>(INTERFACE_TYPE.AuthController);
const authMiddleware = container.get<AuthMiddleware>(
  INTERFACE_TYPE.AuthMiddleware
);

const router = express.Router();

router.put(
  "/api/auth/verifyPasswordReset",
  //authMiddleware.authenticateToken.bind(authMiddleware),
  controller.verifyPasswordReset.bind(controller)
);

router.post(
  "/api/auth/resetPassword",
  // authMiddleware.authenticateToken.bind(authMiddleware),
  controller.resetPassword.bind(controller)
);

router.put(
  "/api/auth/changePassword",
  authMiddleware.authenticateToken.bind(authMiddleware),
  controller.changePassword.bind(controller)
);
router.post("/api/auth/login", controller.login.bind(controller));
router.post("/api/auth/verifyOtp", controller.verifyOtp.bind(controller));
router.post("/api/auth/register", controller.registerUser.bind(controller));
router.get("/api/test", controller.test.bind(controller));

export default router;
