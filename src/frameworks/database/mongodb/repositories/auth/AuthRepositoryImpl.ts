import { injectable } from "inversify";
import { IAuthRepository } from "./IAuthRepository";
import { IUser } from "../../../../../entities/User";
import User, { UserMapper } from "../../models/user";
import { IUserOTP } from "../../../../../entities/UserOTP";
import UserOTP, { OTPMapper } from "../../models/userOTP";
import { NotFoundError } from "../../../../../error_handler";
import { ConflictError } from "../../../../../error_handler/ConflictError";

@injectable()
export class AuthRepositoryImpl implements IAuthRepository {
  async deleteManyOtps(id: string): Promise<IUserOTP> {
    const otp = await UserOTP.findOne({ user: id });
    if (!otp) {
      throw new NotFoundError("OTP not found");
    } else {
      await UserOTP.deleteMany({ user: id });
      return OTPMapper.toEntity(otp);
    }
  }
  async deleteOtp(id: string): Promise<IUserOTP> {
    const otp = await UserOTP.findById(id);
    if (!otp) {
      throw new NotFoundError("OTP not found");
    } else {
      await UserOTP.findByIdAndDelete(id);
      return OTPMapper.toEntity(otp);
    }
  }
  async findOtps(query: IUserOTP): Promise<IUserOTP[]> {
    const otps = await UserOTP.find(query).sort({ createdAt: -1 });
    return otps.map((otp) => OTPMapper.toEntity(otp));
  }
  async addUserOTP(data: IUserOTP): Promise<IUserOTP> {
    const newUserOTP = new UserOTP(data);
    await newUserOTP.save();
    const otp: IUserOTP = OTPMapper.toEntity(newUserOTP);
    return otp;
  }

  async registerUser(data: IUser): Promise<IUser> {
    const user = await User.findOne({ email: data.email });
    if (user) {
      throw new ConflictError("The email already exists");
    }
    const newUser = new User(data);
    await newUser.save();
    // Map the Mongoose document to IUser format
    const result = UserMapper.toEntity(newUser);
    return result;
  }
}
