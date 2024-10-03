import { injectable } from "inversify";
import { IAuthService } from "../../application/interface/IAuthService";
import config from "../../config/config";
import { IUser } from "../../entities/User";
import bcrypt from "bcrypt";
import jwt, { JwtPayload } from "jsonwebtoken";

@injectable()
export class AuthServiceImpl implements IAuthService {
  generateOTP(): number {
    return Math.floor(100000 + Math.random() * 900000);
  }
  async encriptPassword(password: string): Promise<string> {
    const salt = bcrypt.genSaltSync(10);
    return bcrypt.hashSync(password, salt);
  }
  async comparePassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compareSync(password, hash);
  }
  async verifyToken(token: string): Promise<JwtPayload | string> {
    return jwt.verify(token, config.jwtSecret);
  }
  async generateToken(user: IUser): Promise<string> {
    return jwt.sign(user, config.jwtSecret, {
      expiresIn: "2 days",
    });
  }
}
