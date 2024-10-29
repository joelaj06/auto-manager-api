import { NextFunction, Response, Request } from "express";
import { IAuthInteractor } from "../../../application/interactors/auth/IAuthInteractor";
import { inject, injectable } from "inversify";
import { HttpStatusCode, INTERFACE_TYPE } from "../../../utils";
import { ControllerUserRequest } from "./IController";
import { UnprocessableEntityError } from "../../../error_handler";

@injectable()
export class AuthController {
  private interactor: IAuthInteractor;

  constructor(
    @inject(INTERFACE_TYPE.AuthInteractorImpl) interactor: IAuthInteractor
  ) {
    this.interactor = interactor;
  }

  async verifyPasswordReset(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId, otp, newPassword } = req.body;
      const response = await this.interactor.verifyPasswordReset(
        userId,
        otp,
        newPassword
      );
      if (response) {
        return res.status(HttpStatusCode.OK).json(response);
      }
      throw new Error();
    } catch (error) {
      next(error);
    }
  }
  async resetPassword(req: Request, res: Response, next: NextFunction) {
    try {
      const response = await this.interactor.resetPassword(req.body.email);
      if (response) {
        return res.status(HttpStatusCode.OK).json(response);
      }
      throw new Error();
    } catch (error) {
      next(error);
    }
  }
  async changePassword(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ) {
    try {
      //TODO add validation
      req.body.userId = req.user?._id;
      const response = await this.interactor.changePassword(req.body);
      if (response) {
        return res.status(HttpStatusCode.NO_CONTENT).send();
      }
      throw new Error();
    } catch (error) {
      next(error);
    }
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
      return res.status(HttpStatusCode.OK).json(response);
    } catch (error) {
      next(error);
    }
  }
  async verifyOtp(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId, otp } = req.body;
      //TODO add validation
      const response = await this.interactor.verifyOTP(userId, otp);
      return res.status(HttpStatusCode.OK).json(response);
    } catch (error) {
      next(error);
    }
  }
  async registerUser(req: Request, res: Response, next: NextFunction) {
    if (!req.body)
      throw new UnprocessableEntityError("Request body is required");
    try {
      const response = await this.interactor.registerUser(req.body);
      return res.status(HttpStatusCode.CREATED).json(response);
    } catch (error) {
      next(error);
    }
  }
  test(req: Request, res: Response, next: NextFunction) {
    try {
      const response = this.interactor.test();
      return res.status(HttpStatusCode.OK).json(response);
    } catch (error) {
      next(error);
    }
  }
}
