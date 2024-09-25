import { IUser } from "../../entities/User";
import { IAuthInteractor } from "../interface/IAuthInteractor";
import { IAuthRepository } from "../interface/IAuthRepository";
import bcrypt from "bcrypt";
import { IAuthService } from "../interface/IAuthService";
import { inject, injectable } from "inversify";
import { INTERFACE_TYPE } from "../../utils";
import { IMailer } from "../interface/IMailer";

@injectable()
export class AuthInteractorImpl implements IAuthInteractor {
  private repository: IAuthRepository;
  private authService: IAuthService;
  private mailer: IMailer;

  constructor(
    @inject(INTERFACE_TYPE.AuthRepositoryImpl) repository: IAuthRepository,
    @inject(INTERFACE_TYPE.AuthServiceImpl) authService: IAuthService,
    @inject(INTERFACE_TYPE.Mailer) mailer: IMailer
  ) {
    this.repository = repository;
    this.authService = authService;
    this.mailer = mailer;
  }
  async registerUser(data: IUser): Promise<IUser> {
    const hashedPassword = await this.authService.encriptPassword(
      data.password!
    ); // hash password before saving it
    const otp = Math.floor(100000 + Math.random() * 900000);
    const userData: IUser = { ...data, password: hashedPassword };
    // send verification email
    await this.mailer.sendEmail(
      userData.email!,
      "Verify your email",
      `
      <div>
        <p>Hello,</p>
        <p>Your verification code is <b>${otp}</b></p>
        <p>Please enter this code to verify your email address.</p>
      </div>
      <div>
        <p>If you did not request this, please ignore this email.</p>
      </div>
    </div>`
    );
    const result = await this.repository.registerUser(userData);
    return result;
  }

  test(): string {
    return "I'm alive 😁";
  }
}
