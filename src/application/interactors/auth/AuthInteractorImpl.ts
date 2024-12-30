import { IUser, UserPasswordChangeRequest } from "../../../entities/User";
import { IAuthInteractor } from "./IAuthInteractor";
import { IAuthRepository } from "../../../frameworks/database/mongodb/repositories/auth/IAuthRepository";
import bcrypt from "bcrypt";
import { IAuthService } from "../../../frameworks/services/auth/IAuthService";
import { inject, injectable } from "inversify";
import { INTERFACE_TYPE } from "../../../utils";
import { IMailer } from "../../../frameworks/services/mailer/IMailer";
import {
  UserOTPResponse,
  UserRegistrationResponse,
} from "../../../entities/UserResponse";
import { IUserRepository } from "../../../frameworks/database/mongodb/repositories/user/IUserRepository";
import { BadRequestError, NotFoundError } from "../../../error_handler";
import { UnauthorizedError } from "../../../error_handler/UnauthorizedError";
import { UnprocessableEntityError } from "../../../error_handler/UnprocessableEntityError";

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
  logout(): void {
    throw new Error("Method not implemented.");
  }
  async verifyPasswordReset(
    userId: string,
    otp: string,
    newPassword: string
  ): Promise<UserOTPResponse> {
    const userOtpRecords = await this.repository.findOtps({ user: userId });
    if (userOtpRecords.length === 0) {
      throw new BadRequestError("OTP not found. Please request a new one.");
    } else {
      const { expiresAt } = userOtpRecords[0];
      if (expiresAt! < new Date()) {
        await this.repository.deleteManyOtps(userOtpRecords[0].user!);
        throw new BadRequestError("OTP has expired. Please request a new one.");
      } else {
        if (Number(otp) !== userOtpRecords[0].otp) {
          throw new BadRequestError("Invalid or Wrong OTP ");
        } else {
          await this.userRepository.updateUser(userId, {
            _id: userId,
            isVerified: true,
          });
          await this.repository.deleteOtp(userOtpRecords[0]._id!);
          const user = await this.userRepository.findUserById(userId);
          if (!user) {
            throw new Error("User not found");
          }

          const hashedPassword = await this.authService.encriptPassword(
            newPassword
          ); // hash password before updating
          const userData: IUser = {
            ...user,
            password: hashedPassword,
          };

          const updatedUser = await this.userRepository.updateUser(
            user._id!,
            userData
          );

          if (!updatedUser) throw new Error("Error while updating user");
          const { password: pass, ...rest } = userData;

          const res: UserOTPResponse = {
            message: "Password reset successful",
            status: "Success",
            data: {
              ...rest,
            },
          };

          return res;
        }
      }
    }
  }
  async resetPassword(email: string): Promise<UserOTPResponse> {
    if (!email) throw new UnprocessableEntityError("Email is required");
    const user = await this.userRepository.findUserByEmail(email);
    if (!user) throw new NotFoundError("User not found");

    //send user otp via email notification
    await this.sendEmailOTP(
      email,
      "Password Reset",
      "Please enter this code to reset your password"
    );

    const response: UserOTPResponse = {
      status: "Pending",
      message: "OTP Verification email sent",
      data: {
        email: user.email,
        userId: user._id,
      },
    };
    return response;
  }
  async changePassword(data: UserPasswordChangeRequest): Promise<IUser> {
    const { currentPassword, newPassword } = data;
    if (!currentPassword || !newPassword) {
      throw new UnprocessableEntityError("All Fields are required");
    }
    //fetch user and compare current password
    const user = await this.userRepository.findUserById(data.userId);
    if (!user) throw new NotFoundError("User not found");
    const isMatch = await this.authService.comparePassword(
      currentPassword,
      user.password!
    );
    if (!isMatch) {
      throw new BadRequestError("Invalid credentials");
    }
    const hashedPassword = await this.authService.encriptPassword(newPassword); // hash password before saving it
    const userData: IUser = {
      ...user,
      password: hashedPassword,
    };
    const updatedUser = await this.userRepository.updateUser(
      user._id!,
      userData
    );
    if (!updatedUser) throw new Error("Error while updating user");
    const { password: pass, ...rest } = userData;
    return { ...rest };
  }
  async login(
    email: string,
    password: string,
    deviceToken?: string
  ): Promise<IUser> {
    if (!email || !password) {
      throw new UnauthorizedError("Email and password are required");
    }

    const user = await this.userRepository.findUserByEmail(email);
    if (!user) throw new NotFoundError("Sorry User not found");
    //compare password to hash
    const isMatch = await this.authService.comparePassword(
      password,
      user.password!
    );
    if (!isMatch) {
      throw new UnauthorizedError("Invalid credentials");
    }
    if (!user.isVerified) {
      throw new UnauthorizedError(
        "Account not verified. Please verify your email"
      );
    }

    const userObj = {
      ...user,
    };

    const { password: pass, ...rest } = userObj;
    const token = await this.authService.generateToken({ ...rest });

    await this.userRepository.updateUser(user._id!, {
      _id: user._id,
      deviceToken: deviceToken,
    });
    const userData: IUser = {
      ...user,
      token,
    };
    const { password: userPass, ...resData } = userData;
    return { ...resData };
  }

  async verifyOTP(userId: string, otp: string): Promise<UserOTPResponse> {
    const userOtpRecords = await this.repository.findOtps({ user: userId });

    if (userOtpRecords.length === 0) {
      throw new Error(
        "Account record does not exist or has already been verified. Please sign up or login"
      );
    } else {
      const { expiresAt } = userOtpRecords[0];
      if (expiresAt! < new Date()) {
        await this.repository.deleteManyOtps(userOtpRecords[0].user!);
        const user = await this.userRepository.findUserById(userId);
        await this.sendEmailOTP(
          user?.email!,
          "Account Verification New OTP",
          "Please enter this code to verify your email"
        );
        throw new BadRequestError(
          "OTP has expired. A new OTP has been sent to your email."
        );
      } else {
        if (Number(otp) !== userOtpRecords[0].otp) {
          throw new BadRequestError("Invalid OTP");
        } else {
          await this.userRepository.updateUser(userId, {
            _id: userId,
            isVerified: true,
          });
          await this.repository.deleteOtp(userOtpRecords[0]._id!);
          const user = await this.userRepository.findUserById(userId);
          if (!user) {
            throw new NotFoundError("User not found");
          }

          const userObj = {
            ...user,
          };
          const token = await this.authService.generateToken(userObj); // generate and return JWT token along with user data
          const response: UserOTPResponse = {
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
    if (!data) throw new UnprocessableEntityError("User data is required");
    const hashedPassword = await this.authService.encriptPassword(
      data.password!
    ); // hash password before saving it

    const userData: IUser = {
      ...data,
      password: hashedPassword,
      //TODO implement role//role: "admin",
    };
    const result = await this.repository.registerUser(userData);

    await this.sendEmailOTP(
      userData.email!,
      "Account Verification",
      "Please enter this code to verify your email"
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

  async sendEmailOTP(
    email: string,
    subject: string,
    text: string
  ): Promise<void> {
    try {
      if (!email) throw new UnprocessableEntityError("Email is required");
      const user = await this.userRepository.findUserByEmail(email);
      if (!user) throw new NotFoundError("User not found");
      const otp = this.authService.generateOTP(); // generate otp

      // save otp in database or any other storage for verification purpose
      const userOTP = await this.repository.addUserOTP({
        otp,
        user: user._id!,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      // send verification email
      await this.mailer.sendEmail(
        user.email!,
        subject,
        `
        <div>
          <p>Hello,</p>
          <p>Your verification code is <b>${userOTP.otp}</b></p>
          <p>${text}.</p>
          <p>This OTP expires in 1 hour.</p>
        </div>
        <div>
          <p>If you did not request this, please ignore this email.</p>
        </div>
      </div>`
      );
    } catch (error) {
      throw error;
    }
  }
}
