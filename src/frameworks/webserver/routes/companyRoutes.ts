import express from "express";
import { Container } from "inversify";
import { CompanyController } from "../../../adapters/controllers/company_controller/CompanyController";
import {
  CompanyInteractorImpl,
  ICompanyInteractor,
} from "../../../application/interactors";
import { INTERFACE_TYPE, Permissions, UserPermissions } from "../../../utils";
import {
  CompanyRepositoryImpl,
  ICompanyRepository,
  IUserRepository,
  UserRepositoryImpl,
} from "../../database/mongodb";
import { AuthMiddleware } from "../middleware/AuthMiddleware";
import { IAuthService } from "../../services/auth/IAuthService";
import {
  AuthServiceImpl,
  CloudinaryImpl,
  IStorageBucket,
} from "../../services";

const container = new Container();

container
  .bind<IUserRepository>(INTERFACE_TYPE.UserRepositoryImpl)
  .to(UserRepositoryImpl);

container
  .bind<ICompanyRepository>(INTERFACE_TYPE.CompanyRepositoryImpl)
  .to(CompanyRepositoryImpl);

container
  .bind<IStorageBucket>(INTERFACE_TYPE.StorageBucketImpl)
  .to(CloudinaryImpl);

container
  .bind<ICompanyInteractor>(INTERFACE_TYPE.CompanyInteractorImpl)
  .to(CompanyInteractorImpl);

container.bind<CompanyController>(CompanyController).to(CompanyController);

container
  .bind<IAuthService>(INTERFACE_TYPE.AuthServiceImpl)
  .to(AuthServiceImpl);

container
  .bind<AuthMiddleware>(INTERFACE_TYPE.AuthMiddleware)
  .to(AuthMiddleware);

const controller = container.get<CompanyController>(CompanyController);

const authMiddleware = container.get<AuthMiddleware>(
  INTERFACE_TYPE.AuthMiddleware
);

const router = express.Router();

router
  .route("/api/companies")
  .get(
    authMiddleware.authenticateToken.bind(authMiddleware),
    controller.getAllCompanies.bind(controller)
  )
  .post(
    // authMiddleware.authenticateToken.bind(authMiddleware),
    controller.addCompany.bind(controller)
  );

router
  .route("/api/companies/:id")
  .get(
    authMiddleware.authenticateToken.bind(authMiddleware),
    controller.getACompany.bind(controller)
  )
  .put(
    authMiddleware.authenticateToken.bind(authMiddleware),
    authMiddleware
      .checkPermission(Permissions.UPDATE_COMPANY)
      .bind(authMiddleware),
    controller.updateCompany.bind(controller)
  );

export default router;
