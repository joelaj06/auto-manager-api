import { Container } from "inversify";
import {
  ExpenseCategoryRepositoryImpl,
  ExpenseRepositoryImpl,
  IExpenseCategoryRepository,
  IExpenseRepository,
} from "../../database/mongodb";
import { INTERFACE_TYPE } from "../../../utils";
import {
  ExpenseCategoryInteractorImpl,
  IExpenseCategoryInteractor,
} from "../../../application/interactors";
import { AuthServiceImpl } from "../../services";
import { IAuthService } from "../../services/auth/IAuthService";
import { AuthMiddleware } from "../middleware/AuthMiddleware";
import { ExpenseCategoryController } from "../../../adapters/controllers/expense_controller/ExpenseCategoryController";
import express from "express";

const container = new Container();

container
  .bind<IExpenseCategoryRepository>(
    INTERFACE_TYPE.ExpenseCategoryRepositoryImpl
  )
  .to(ExpenseCategoryRepositoryImpl);

container
  .bind<IExpenseCategoryInteractor>(
    INTERFACE_TYPE.ExpenseCategoryInteractorImpl
  )
  .to(ExpenseCategoryInteractorImpl);

container
  .bind<IAuthService>(INTERFACE_TYPE.AuthServiceImpl)
  .to(AuthServiceImpl);

container
  .bind<AuthMiddleware>(INTERFACE_TYPE.AuthMiddleware)
  .to(AuthMiddleware);

container
  .bind<ExpenseCategoryController>(ExpenseCategoryController)
  .to(ExpenseCategoryController);

const controller = container.get<ExpenseCategoryController>(
  ExpenseCategoryController
);
const authMiddleware = container.get<AuthMiddleware>(
  INTERFACE_TYPE.AuthMiddleware
);

const router = express.Router();

router.get(
  "/api/expense/expenseCategories",
  authMiddleware.authenticateToken.bind(authMiddleware),
  controller.getAllExpenseCategory.bind(controller)
);

router.post(
  "/api/expense/expenseCategories",
  authMiddleware.authenticateToken.bind(authMiddleware),
  controller.addExpenseCategory.bind(controller)
);

router.get(
  "/api/expense/expenseCategories/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  controller.getAnExpenseCategory.bind(controller)
);

router.put(
  "/api/expense/expenseCategories/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  controller.updateExpenseCategory.bind(controller)
);

router.delete(
  "/api/expense/expenseCategories/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  controller.deleteExpenseCategory.bind(controller)
);

export default router;
