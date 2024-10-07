import { IUser, UserPasswordChangeRequest } from "../../../entities/User";
import {
  UserOTPResponse,
  UserRegistrationResponse,
} from "../../../entities/UserResponse";

export interface IAuthInteractor {
  logout(): void;
  login(email: string, password: string, deviceToken?: string): Promise<IUser>;
  test(): void;
  registerUser(data: IUser): Promise<UserRegistrationResponse>;
  verifyOTP(userId: string, otp: string): Promise<UserOTPResponse>;
  changePassword(data: UserPasswordChangeRequest): Promise<IUser>;
  resetPassword(email: string): Promise<UserOTPResponse>;
  verifyPasswordReset(
    userId: string,
    otp: string,
    newPassword: string
  ): Promise<UserOTPResponse>;
}
