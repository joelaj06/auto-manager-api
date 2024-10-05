import { JwtPayload } from "jsonwebtoken";
import { IUser } from "../../../entities/User";

export interface IAuthService {
  encriptPassword(password: string): Promise<string>;
  comparePassword(password: string, hash: string): Promise<boolean>;
  verifyToken<T extends object>(token: string): Promise<T>;
  generateToken(data: Object): Promise<string>;
  generateOTP(): number;
}
