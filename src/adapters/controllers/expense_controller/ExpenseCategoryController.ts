import { inject, injectable } from "inversify";
import { IExpenseCategoryInteractor } from "../../../application/interactors";
import { HttpStatusCode, INTERFACE_TYPE } from "../../../utils";
import { NextFunction, Request, Response } from "express";
import { ControllerUserRequest } from "../auth_controller/IController";
import { BadRequestError } from "../../../error_handler";
import { RequestQuery } from "../../../entities";

@injectable()
export class ExpenseCategoryController {
  private expenseCategoryInteractor: IExpenseCategoryInteractor;

  constructor(
    @inject(INTERFACE_TYPE.ExpenseCategoryInteractorImpl)
    expenseCategoryInteractor: IExpenseCategoryInteractor
  ) {
    this.expenseCategoryInteractor = expenseCategoryInteractor;
  }

  async getAllExpenseCategory(req: Request, res: Response, next: NextFunction) {
    try {
      const query: RequestQuery = {
        search: req.query.search ? req.query.search.toString() : undefined,
        ...req.query,
      };
      const response =
        await this.expenseCategoryInteractor.getAllExpenseCategory(query);
      return res.status(HttpStatusCode.OK).json(response);
    } catch (error) {
      next(error);
    }
  }

  async addExpenseCategory(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const data = {
        ...req.body,
        createdBy: req.user,
      };
      const response = await this.expenseCategoryInteractor.addExpenseCategory(
        data
      );
      return res.status(HttpStatusCode.CREATED).json(response);
    } catch (error) {
      next(error);
    }
  }

  async getAnExpenseCategory(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const response =
        await this.expenseCategoryInteractor.getAnExpenseCategory(id);
      return res.status(HttpStatusCode.OK).json(response);
    } catch (error) {
      next(error);
    }
  }

  async updateExpenseCategory(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const { id } = req.params;
      if (!id) throw new BadRequestError("Expense category id is required");
      const response =
        await this.expenseCategoryInteractor.updateExpenseCategory(
          id,
          req.body
        );

      if (!response)
        throw new BadRequestError("Error while updating expense category");
      return res.status(HttpStatusCode.OK).json(response);
    } catch (error) {
      next(error);
    }
  }

  async deleteExpenseCategory(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      const { id } = req.params;
      if (!id) throw new BadRequestError("Expense category id is required");
      const response =
        await this.expenseCategoryInteractor.deleteExpenseCategory(id);

      if (!response)
        throw new BadRequestError("Error while deleting expense category");
      return res.status(HttpStatusCode.NO_CONTENT).json();
    } catch (error) {
      next(error);
    }
  }
}
