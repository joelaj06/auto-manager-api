import { IUser } from "../../../../../entities/User";

export interface IUserRepository {
  updateUser(data: IUser): Promise<IUser>;
  findUserById(id: string): Promise<IUser>;
  findUserByEmail(email: string): Promise<IUser>;
}
