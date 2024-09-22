import { IUser } from "../../entities/User";
import { IAuthInteractor } from "../interface/IAuthInteractor";
import { IAuthRepository } from "../interface/IAuthRepository";
import bcrypt from "bcrypt";
import { IAuthService } from "../interface/IAuthService";

export class AuthInteractorImpl implements IAuthInteractor {
  private repository: IAuthRepository;
  private authService: IAuthService;

  constructor(repository: IAuthRepository, authService: IAuthService) {
    this.repository = repository;
    this.authService = authService;
  }
  async registerUser(data: IUser): Promise<IUser> {
    const hashedPassword = await this.authService.encriptPassword(
      data.password!
    ); // hash password before saving it
    const userData: IUser = { ...data, password: hashedPassword };
    const result = await this.repository.registerUser(userData);
    return result;
  }

  test(): string {
    return "I'm alive 😁";
  }
}
