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

  async login(req: Request, res: Response, next: NextFunction) {
    try {
      //TODO add validation

      const response = await this.interactor.login(
        req.body.email,
        req.body.password,
        req.body.deviceToken
      );
      //send token as header
      res.set("accessToken", response.token);
      return res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }
  async verifyOtp(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId, otp } = req.body;
      //TODO add validation
      const response = await this.interactor.verifyOTP(userId, otp);
      return res.status(200).json(response);
    } catch (error) {
      next(error);
    }
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
