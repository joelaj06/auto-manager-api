import { IUser, UserPasswordChangeRequest } from "../../../entities/User";
import {
  UserOTPVerificationResponse,
  UserRegistrationResponse,
} from "../../../entities/UserResponse";

export interface IAuthInteractor {
  login(email: string, password: string, deviceToken?: string): Promise<IUser>;
  test(): void;
  registerUser(data: IUser): Promise<UserRegistrationResponse>;
  verifyOTP(userId: string, otp: string): Promise<UserOTPVerificationResponse>;
  changePassword(data: UserPasswordChangeRequest): Promise<IUser>;
}
