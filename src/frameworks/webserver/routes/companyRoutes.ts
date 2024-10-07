import express from "express";
import { Container } from "inversify";
import { CompanyController } from "../../../adapters/controllers/company_controller/CompanyController";
import {
  CompanyInteractorImpl,
  ICompanyInteractor,
} from "../../../application/interactors";
import { INTERFACE_TYPE } from "../../../utils";
import {
  CompanyRepositoryImpl,
  ICompanyRepository,
} from "../../database/mongodb";
import { AuthMiddleware } from "../middleware/AuthMiddleware";
import { IAuthService } from "../../services/auth/IAuthService";
import { AuthServiceImpl } from "../../services";

const container = new Container();

container
  .bind<ICompanyRepository>(INTERFACE_TYPE.CompanyRepositoryImpl)
  .to(CompanyRepositoryImpl);
container
  .bind<ICompanyInteractor>(INTERFACE_TYPE.CompanyInteractorImpl)
  .to(CompanyInteractorImpl);
container.bind<CompanyController>(CompanyController).to(CompanyController);
container
  .bind<IAuthService>(INTERFACE_TYPE.AuthServiceImpl)
  .to(AuthServiceImpl);
container.bind<AuthMiddleware>(AuthMiddleware).to(AuthMiddleware);
const controller = container.get<CompanyController>(CompanyController);
const authMiddleware = container.get<AuthMiddleware>(AuthMiddleware);

const router = express.Router();

router
  .route("/api/companies")
  .post(
    authMiddleware.authenticateToken.bind(authMiddleware),
    controller.addCompany.bind(controller)
  );
export default router;
