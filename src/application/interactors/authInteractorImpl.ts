import { IUser } from "../../entities/User";
import { IAuthInteractor } from "../interface/IAuthInteractor";
import { IAuthRepository } from "../interface/IAuthRepository";

export class AuthInteractorImpl implements IAuthInteractor {
  private repository: IAuthRepository;

  constructor(repository: IAuthRepository) {
    this.repository = repository;
  }
  async registerUser(data: IUser): Promise<IUser> {
    const result = await this.repository.registerUser(data);
    return result;
  }

  test(): string {
    return "I'm alive 😁";
  }
}
