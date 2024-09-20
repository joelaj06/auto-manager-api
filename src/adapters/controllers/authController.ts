import { NextFunction, Response, Request } from "express";
import { IAuthInteractor } from "../../application/interface/IAuthInteractor";

export class AuthController {
  private interactor: IAuthInteractor;

  constructor(interactor: IAuthInteractor) {
    this.interactor = interactor;
  }

  test(req: Request, res: Response, next: NextFunction) {
    try {
      const response = this.interactor.test();
      return res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }
}
