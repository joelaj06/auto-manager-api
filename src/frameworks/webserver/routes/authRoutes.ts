import express from "express";
import { AuthController } from "../../../adapters/controllers/authController";
import { AuthInteractorImpl } from "../../../application/interactors/authInteractorImpl";
import { AuthRepositoryImpl } from "../../database/mongodb/repositories/authRepositoryImpl";
import { AuthServiceImpl } from "../../services/authService";
import { Container } from "inversify";
import { IAuthInteractor } from "../../../application/interface/IAuthInteractor";
import { IAuthRepository } from "../../../application/interface/IAuthRepository";
import { IAuthService } from "../../../application/interface/IAuthService";
import { INTERFACE_TYPE } from "../../../utils/constants";

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
const controller = container.get<AuthController>(INTERFACE_TYPE.AuthController);

const router = express.Router();

router.post("/api/auth/register", controller.registerUser.bind(controller));
router.get("/api/test", controller.test.bind(controller));

export default router;
