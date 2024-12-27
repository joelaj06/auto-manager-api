import { inject, injectable } from "inversify";
import { IExpenseInteractor } from "../../../application/interactors/expense/IExpenseInteractor";
import { HttpStatusCode, INTERFACE_TYPE } from "../../../utils";
import { NextFunction, Request, Response } from "express";
import { ControllerUserRequest } from "../auth_controller/IController";
import { ExpenseRequestQuery } from "../../../entities";
import { BadRequestError } from "../../../error_handler";

@injectable()
export class ExpenseController {
  private expenseInteractor: IExpenseInteractor;

  constructor(
    @inject(INTERFACE_TYPE.ExpenseInteractorImpl)
    expenseInteractor: IExpenseInteractor
  ) {
    this.expenseInteractor = expenseInteractor;
  }

  async addExpense(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const data = {
        ...req.body,
        createdBy: req.user,
        company: req.user?.company || req.body.companyId,
        vehicle: req.body.vehicleId,
      };

      if (!data.company) throw new BadRequestError("CompanyId is required");

      const expense = await this.expenseInteractor.addExpense(data);
      res.status(HttpStatusCode.CREATED).json(expense);
    } catch (error) {
      next(error);
    }
  }

  async getAnExpense(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const response = await this.expenseInteractor.getAnExpense(id);
      return res.status(HttpStatusCode.OK).json(response);
    } catch (error) {
      next(error);
    }
  }

  async getAllExpenses(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const query: ExpenseRequestQuery = {
        search: req.query.search ? req.query.search.toString() : undefined,
        categoryId: req.query.categoryId
          ? req.query.categoryId.toString()
          : undefined,
        status: req.query.status ? req.query.status.toString() : undefined,
        pageIndex: req.query.pageIndex
          ? Number(req.query.pageIndex)
          : undefined,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
        companyId: req.user?.company,
        ...req.query,
      };

      const response = await this.expenseInteractor.getAllExpenses(query);
      res.set({
        "x-pagination": JSON.stringify({
          totalPages: response.totalPages,
          pageCount: response.pageCount,
          totalCount: response.totalCount,
        }),
        _meta_total_expenses: response.totalSum,
      });
      return res.status(HttpStatusCode.OK).json(response.data);
    } catch (error) {
      next(error);
    }
  }

  async deleteExpense(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      if (!id) throw new BadRequestError("Expense id is required");
      const expense = await this.expenseInteractor.deleteExpense(id);
      if (!expense) throw new BadRequestError("Error while deleting expense");
      return res.status(HttpStatusCode.NO_CONTENT).json();
    } catch (error) {
      next(error);
    }
  }

  async updateExpense(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const { id } = req.params;
      if (!id) throw new BadRequestError("Expense id is required");
      const response = await this.expenseInteractor.updateExpense(id, req.body);
      if (!response) throw new BadRequestError("Error while updating expense");
      return res.status(HttpStatusCode.OK).json(response);
    } catch (error) {
      next(error);
    }
  }
}
