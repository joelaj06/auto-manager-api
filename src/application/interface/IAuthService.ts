import { JwtPayload } from "jsonwebtoken";
import { IUser } from "../../entities/User";

export interface IAuthService {
  encriptPassword(password: string): Promise<string>;
  comparePassword(password: string, hash: string): Promise<boolean>;
  verifyToken(token: string): Promise<JwtPayload | string>;
  generateToken(data: Object): Promise<string>;
  generateOTP(): number;
}
