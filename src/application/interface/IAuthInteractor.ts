import { IUser } from "../../entities/User";
import {
  UserOTPVerificationResponse,
  UserRegistrationResponse,
} from "../../entities/UserOTPResponse";

export interface IAuthInteractor {
  test(): void;
  registerUser(data: IUser): Promise<UserRegistrationResponse>;
  verifyOTP(userId: string, otp: string): Promise<UserOTPVerificationResponse>;
}
