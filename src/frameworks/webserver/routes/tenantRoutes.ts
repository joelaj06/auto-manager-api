import express from "express";
import { Container } from "inversify";
import { TenantController } from "../../../adapters/controllers/tenant_controller/TenantController";
import {
  TenantInteractorImpl,
  ITenantInteractor,
  CompanyInteractorImpl,
  ICompanyInteractor,
} from "../../../application/interactors";
import { INTERFACE_TYPE, Permissions } from "../../../utils/constants";
import {
  TenantRepositoryImpl,
  ITenantRepository,
  IRoleRepository,
  IUserRepository,
  RoleRepositoryImpl,
  UserRepositoryImpl,
  ICompanyRepository,
  CompanyRepositoryImpl,
} from "../../database/mongodb";
import { AuthMiddleware } from "../middleware/AuthMiddleware";
import { IAuthService } from "../../services/auth/IAuthService";
import {
  AuthServiceImpl,
  CloudinaryImpl,
  IStorageBucket,
} from "../../services";
import { ITenantProvisioningService } from "../../../application/interactors/tenant/ITenantProvisioningService";
import { TenantProvisioningServiceImpl } from "../../../application/interactors/tenant/TenantProvisionalServiceImpl";

const container = new Container();

container
  .bind<IStorageBucket>(INTERFACE_TYPE.StorageBucketImpl)
  .to(CloudinaryImpl);

container
  .bind<ICompanyRepository>(INTERFACE_TYPE.CompanyRepositoryImpl)
  .to(CompanyRepositoryImpl);
container
  .bind<ICompanyInteractor>(INTERFACE_TYPE.CompanyInteractorImpl)
  .to(CompanyInteractorImpl);

container
  .bind<ITenantRepository>(INTERFACE_TYPE.TenantRepositoryImpl)
  .to(TenantRepositoryImpl);

container
  .bind<IRoleRepository>(INTERFACE_TYPE.RoleRepositoryImpl)
  .to(RoleRepositoryImpl);

container
  .bind<IUserRepository>(INTERFACE_TYPE.UserRepositoryImpl)
  .to(UserRepositoryImpl);

container
  .bind<ITenantProvisioningService>(
    INTERFACE_TYPE.TenantProvisioningServiceImpl,
  )
  .to(TenantProvisioningServiceImpl);
container
  .bind<ITenantInteractor>(INTERFACE_TYPE.TenantInteractorImpl)
  .to(TenantInteractorImpl);
container.bind<TenantController>(TenantController).to(TenantController);
container
  .bind<IAuthService>(INTERFACE_TYPE.AuthServiceImpl)
  .to(AuthServiceImpl);
container
  .bind<AuthMiddleware>(INTERFACE_TYPE.AuthMiddleware)
  .to(AuthMiddleware);

const controller = container.get<TenantController>(TenantController);
const authMiddleware = container.get<AuthMiddleware>(
  INTERFACE_TYPE.AuthMiddleware,
);

const requireAdmin = [
  authMiddleware.authenticateToken.bind(authMiddleware),
  // authMiddleware
  //   .checkPermission(Permissions.MANAGE_TENANTS)
  //   .bind(authMiddleware),
];

const router = express.Router();

router
  .route("/api/admin/tenants")
  .post(...requireAdmin, controller.createTenant.bind(controller))
  .get(...requireAdmin, controller.getAllTenants.bind(controller));

router
  .route("/api/admin/tenants/:id")
  .get(...requireAdmin, controller.getTenant.bind(controller))
  .patch(...requireAdmin, controller.updateTenant.bind(controller))
  .delete(...requireAdmin, controller.deleteTenant.bind(controller));

router.post(
  "/api/admin/tenants/:id/activate",
  ...requireAdmin,
  controller.activateTenant.bind(controller),
);
router.post(
  "/api/admin/tenants/:id/deactivate",
  ...requireAdmin,
  controller.deactivateTenant.bind(controller),
);
router.post(
  "/api/admin/tenants/:id/suspend",
  ...requireAdmin,
  controller.suspendTenant.bind(controller),
);
router.post(
  "/api/admin/tenants/:id/renew-subscription",
  ...requireAdmin,
  controller.renewSubscription.bind(controller),
);

export default router;
