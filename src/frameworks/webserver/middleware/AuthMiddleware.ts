import { Request, Response, NextFunction } from "express";

import { IUser } from "../../../entities/User";
import { UnauthorizedError } from "../../../error_handler/UnauthorizedError";
import { inject, injectable } from "inversify";
import { IAuthService } from "../../services/auth/IAuthService";
import { INTERFACE_TYPE } from "../../../utils";

interface UserRequest extends Request {
  user?: IUser; // You can replace `any` with the actual user type if known
}

@injectable()
export class AuthMiddleware {
  private authService: IAuthService;

  constructor(
    @inject(INTERFACE_TYPE.AuthServiceImpl) authService: IAuthService
  ) {
    this.authService = authService;
  }

  async authenticateToken(req: UserRequest, res: Response, next: NextFunction) {
    const authHeader = req.header("Authorization");

    if (authHeader && authHeader.startsWith("Bearer")) {
      const token = authHeader.split(" ")[1];
      try {
        const user = await this.authService.verifyToken<IUser>(token);
        if (user) {
          req.user = user;
          next();
        } else {
          return next(new UnauthorizedError("Invalid token"));
        }
      } catch (error) {
        return next(new UnauthorizedError(error as unknown as string));
      }
    } else {
      return next(new UnauthorizedError("Access denied. No token provided"));
    }
  }
}
