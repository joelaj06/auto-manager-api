import { IUser } from "../../entities/User";

export interface IAuthInteractor {
  test(): void;
  registerUser(data: IUser): Promise<IUser>;
}
