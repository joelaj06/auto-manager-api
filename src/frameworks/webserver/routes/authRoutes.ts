import { IUser } from "./../../../entities/User";
import express from "express";
import { AuthController } from "../../../adapters/controllers/authController";
import { AuthInteractorImpl } from "../../../application/interactors/index";

import { Container } from "inversify";
import { IAuthRepository } from "../../../application/interface/IAuthRepository";
import { INTERFACE_TYPE } from "../../../utils/constants";

import {
  IUserRepository,
  IAuthInteractor,
  IAuthService,
  IMailer,
} from "../../../application/interface/index";

import { AuthServiceImpl, Mailer } from "../../services/index";

import {
  UserRepositoryImpl,
  AuthRepositoryImpl,
} from "../../database/mongodb/repositories/index";

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

container.bind<IMailer>(INTERFACE_TYPE.Mailer).to(Mailer);
const controller = container.get<AuthController>(INTERFACE_TYPE.AuthController);

const router = express.Router();

router.post("/api/auth/verifyOtp", controller.verifyOtp.bind(controller));
router.post("/api/auth/register", controller.registerUser.bind(controller));
router.get("/api/test", controller.test.bind(controller));

export default router;
