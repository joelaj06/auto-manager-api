import { Container } from "inversify";
import {
  ExpenseCategoryRepositoryImpl,
  ExpenseRepositoryImpl,
  IExpenseCategoryRepository,
  IExpenseRepository,
} from "../../database/mongodb";
import { INTERFACE_TYPE, Permissions } from "../../../utils";
import {
  ExpenseCategoryInteractorImpl,
  ExpenseInteractorImpl,
  IExpenseCategoryInteractor,
  IExpenseInteractor,
} from "../../../application/interactors";
import { AuthServiceImpl } from "../../services";
import { IAuthService } from "../../services/auth/IAuthService";
import { AuthMiddleware } from "../middleware/AuthMiddleware";
import { ExpenseCategoryController } from "../../../adapters/controllers/expense_controller/ExpenseCategoryController";
import express from "express";
import { ExpenseController } from "../../../adapters/controllers/expense_controller/ExpenseController";

const container = new Container();

//expense container
container
  .bind<IExpenseRepository>(INTERFACE_TYPE.ExpenseRepositoryImpl)
  .to(ExpenseRepositoryImpl);

container
  .bind<IExpenseInteractor>(INTERFACE_TYPE.ExpenseInteractorImpl)
  .to(ExpenseInteractorImpl);

container
  .bind<ExpenseController>(INTERFACE_TYPE.ExpenseController)
  .to(ExpenseController);

//expense category container
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

const expenseCategoryController = container.get<ExpenseCategoryController>(
  ExpenseCategoryController
);

// expense controller

// Create a new instance of the controller and bind it to the router.
const expenseController = container.get<ExpenseController>(
  INTERFACE_TYPE.ExpenseController
);

const authMiddleware = container.get<AuthMiddleware>(
  INTERFACE_TYPE.AuthMiddleware
);

const router = express.Router();

//expense routes
router.get(
  "/api/expenses",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware
    .checkPermission(Permissions.VIEW_EXPENSES)
    .bind(authMiddleware),
  expenseController.getAllExpenses.bind(expenseController)
);

router.get(
  "/api/expenses/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware.checkPermission(Permissions.VIEW_EXPENSE).bind(authMiddleware),
  expenseController.getAnExpense.bind(expenseController)
);
router.post(
  "/api/expenses",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware
    .checkPermission(Permissions.CREATE_EXPENSE)
    .bind(authMiddleware),
  expenseController.addExpense.bind(expenseController)
);

router.put(
  "/api/expenses/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware
    .checkPermission(Permissions.UPDATE_EXPENSE)
    .bind(authMiddleware),
  expenseController.updateExpense.bind(expenseController)
);

router.delete(
  "/api/expenses/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware
    .checkPermission(Permissions.DELETE_EXPENSE)
    .bind(authMiddleware),
  expenseController.deleteExpense.bind(expenseController)
);

//expense category routes
router.get(
  "/api/expense/expenseCategories",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware
    .checkPermission(Permissions.VIEW_EXPENSE_CATEGORIES)
    .bind(authMiddleware),
  expenseCategoryController.getAllExpenseCategory.bind(
    expenseCategoryController
  )
);

router.post(
  "/api/expense/expenseCategories",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware
    .checkPermission(Permissions.CREATE_EXPENSE_CATEGORY)
    .bind(authMiddleware),
  expenseCategoryController.addExpenseCategory.bind(expenseCategoryController)
);

router.get(
  "/api/expense/expenseCategories/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware
    .checkPermission(Permissions.VIEW_EXPENSE_CATEGORY)
    .bind(authMiddleware),
  expenseCategoryController.getAnExpenseCategory.bind(expenseCategoryController)
);

router.put(
  "/api/expense/expenseCategories/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware
    .checkPermission(Permissions.UPDATE_EXPENSE_CATEGORY)
    .bind(authMiddleware),
  expenseCategoryController.updateExpenseCategory.bind(
    expenseCategoryController
  )
);

router.delete(
  "/api/expense/expenseCategories/:id",
  authMiddleware.authenticateToken.bind(authMiddleware),
  authMiddleware
    .checkPermission(Permissions.DELETE_EXPENSE_CATEGORY)
    .bind(authMiddleware),
  expenseCategoryController.deleteExpenseCategory.bind(
    expenseCategoryController
  )
);

export default router;
