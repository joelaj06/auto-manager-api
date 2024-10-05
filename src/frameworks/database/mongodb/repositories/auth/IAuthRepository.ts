import { IUser } from "../../../../../entities/User";
import { IUserOTP } from "../../../../../entities/UserOTP";

export interface IAuthRepository {
  deleteManyOtps(id: string): Promise<IUserOTP>;
  findOtps(query: IUserOTP): Promise<IUserOTP[]>;
  registerUser(data: IUser): Promise<IUser>;
  addUserOTP(data: IUserOTP): Promise<IUserOTP>;
  deleteOtp(id: string): Promise<IUserOTP>;
}
