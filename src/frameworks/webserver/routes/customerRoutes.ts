import { Container } from "inversify";
import { INTERFACE_TYPE, Permissions } from "../../../utils";
import { AuthServiceImpl } from "../../services";
import { IAuthService } from "../../services/auth/IAuthService";
import { AuthMiddleware } from "../middleware/AuthMiddleware";
import {
  CustomerRepositoryImpl,
  ICustomerRepository,
} from "../../database/mongodb";
import {
  CustomerInteractorImpl,
  ICustomerInteractor,
} from "../../../application/interactors";
import { CustomerController } from "../../../adapters/controllers/customer_controller/CustomerController";
import express from "express";

const container = new Container();

container
  .bind<IAuthService>(INTERFACE_TYPE.AuthServiceImpl)
  .to(AuthServiceImpl);

container
  .bind<AuthMiddleware>(INTERFACE_TYPE.AuthMiddleware)
  .to(AuthMiddleware);

container
  .bind<ICustomerRepository>(INTERFACE_TYPE.CustomerRepositoryImpl)
  .to(CustomerRepositoryImpl);

container
  .bind<ICustomerInteractor>(INTERFACE_TYPE.CustomerInteractorImpl)
  .to(CustomerInteractorImpl);

container
  .bind<CustomerController>(INTERFACE_TYPE.CustomerController)
  .to(CustomerController);

const authMiddleware = container.get<AuthMiddleware>(
  INTERFACE_TYPE.AuthMiddleware
);

const customerController = container.get<CustomerController>(
  INTERFACE_TYPE.CustomerController
);

const router = express.Router();

router.get(
  "/api/customers",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware
    .checkPermission(Permissions.VIEW_CUSTOMERS)
    .bind(authMiddleware),
  customerController.getAllCustomers.bind(customerController)
);
router.post(
  "/api/customers",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware
    .checkPermission(Permissions.CREATE_CUSTOMER)
    .bind(authMiddleware),
  customerController.saveCustomer.bind(customerController)
);
router.get(
  "/api/customers/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware
    .checkPermission(Permissions.VIEW_CUSTOMER)
    .bind(authMiddleware),
  customerController.getACustomer.bind(customerController)
);
router.put(
  "/api/customers/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware
    .checkPermission(Permissions.UPDATE_CUSTOMER)
    .bind(authMiddleware),
  customerController.updateCustomer.bind(customerController)
);
router.delete(
  "/api/customers/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware
    .checkPermission(Permissions.DELETE_CUSTOMER)
    .bind(authMiddleware),
  customerController.deleteCustomer.bind(customerController)
);

export default router;
