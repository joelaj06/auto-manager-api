import { NextFunction, Response, Request } from "express";
import { IAuthInteractor } from "../../application/interface/IAuthInteractor";
import { inject, injectable } from "inversify";
import { INTERFACE_TYPE } from "../../utils";

@injectable()
export class AuthController {
  private interactor: IAuthInteractor;

  constructor(
    @inject(INTERFACE_TYPE.AuthInteractorImpl) interactor: IAuthInteractor
  ) {
    this.interactor = interactor;
  }

  async registerUser(req: Request, res: Response, next: NextFunction) {
    try {
      const response = await this.interactor.registerUser(req.body);
      return res.status(200).json(response);
    } catch (error) {
      next(error);
    }
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
