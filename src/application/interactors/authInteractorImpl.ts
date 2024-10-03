import { IUser } from "../../entities/User";
import { IAuthInteractor } from "../interface/IAuthInteractor";
import { IAuthRepository } from "../interface/IAuthRepository";
import bcrypt from "bcrypt";
import { IAuthService } from "../interface/IAuthService";
import { inject, injectable } from "inversify";
import { INTERFACE_TYPE } from "../../utils";
import { IMailer } from "../interface/IMailer";
import {
  UserOTPVerificationResponse,
  UserRegistrationResponse,
} from "../../entities/UserOTPResponse";
import { IUserRepository } from "../interface/IUserRepository";

@injectable()
export class AuthInteractorImpl implements IAuthInteractor {
  private repository: IAuthRepository;
  private authService: IAuthService;
  private mailer: IMailer;
  private userRepository: IUserRepository;

  constructor(
    @inject(INTERFACE_TYPE.AuthRepositoryImpl) repository: IAuthRepository,
    @inject(INTERFACE_TYPE.AuthServiceImpl) authService: IAuthService,
    @inject(INTERFACE_TYPE.Mailer) mailer: IMailer,
    @inject(INTERFACE_TYPE.UserRepositoryImpl) userRepository: IUserRepository
  ) {
    this.repository = repository;
    this.authService = authService;
    this.mailer = mailer;
    this.userRepository = userRepository;
  }
  async verifyOTP(
    userId: string,
    otp: string
  ): Promise<UserOTPVerificationResponse> {
    const userOtpRecords = await this.repository.findOtps({ user: userId });

    console.log(userOtpRecords);
    if (userOtpRecords.length === 0) {
      throw new Error(
        "Account record does not exist or has already been verified. Please sign up or login"
      );
    } else {
      const { expiresAt } = userOtpRecords[0];
      if (expiresAt! < new Date()) {
        await this.repository.deleteManyOtps(userOtpRecords[0].user!);
        throw new Error("OTP has expired. Please request a new one.");
      } else {
        if (Number(otp) !== userOtpRecords[0].otp) {
          throw new Error("Invalid OTP");
        } else {
          await this.userRepository.updateUser({
            _id: userId,
            isVerified: true,
          });
          await this.repository.deleteOtp(userOtpRecords[0]._id!);
          const user = await this.userRepository.findUserById(userId);
          if (!user) {
            throw new Error("User not found");
          }

          const userObj = {
            ...user,
          };
          const token = await this.authService.generateToken(userObj); // generate and return JWT token along with user data
          const response: UserOTPVerificationResponse = {
            message: "OTP verified successfully",
            status: "Success",
            data: {
              ...user,
              token,
            },
          };

          return response;
        }
      }
    }
  }

  async registerUser(data: IUser): Promise<UserRegistrationResponse> {
    const hashedPassword = await this.authService.encriptPassword(
      data.password!
    ); // hash password before saving it

    const userData: IUser = { ...data, password: hashedPassword };
    const result = await this.repository.registerUser(userData);

    const otp = this.authService.generateOTP(); // generate otp

    // save otp in database or any other storage for verification purpose
    const userOTP = await this.repository.addUserOTP({
      otp,
      user: result._id!,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    console.log("New user ", userOTP.user);
    // send verification email
    await this.mailer.sendEmail(
      userData.email!,
      "Verify your email",
      `
      <div>
        <p>Hello,</p>
        <p>Your verification code is <b>${userOTP.otp}</b></p>
        <p>Please enter this code to verify your email address.</p>
        <p>This OTP expires in 1 hour.</p>
      </div>
      <div>
        <p>If you did not request this, please ignore this email.</p>
      </div>
    </div>`
    );

    const response: UserRegistrationResponse = {
      status: "Pending",
      message: "OTP Verification email sent",
      data: {
        email: result.email,
        userId: result._id,
      },
    };
    return response;
  }

  test(): string {
    return "I'm alive 😁";
  }
}
