import { IUser } from "../../entities/User";

export interface IAuthRepository {
  registerUser(data: IUser): Promise<IUser>;
}
