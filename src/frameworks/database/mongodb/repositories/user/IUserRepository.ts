import { IUser, UserRequestQuery } from "../../../../../entities/User";
import { PaginatedResponse } from "../../../../../entities/UserResponse";

export interface IUserRepository {
  updateUser(id: string, data: IUser): Promise<IUser>;
  findUserById(id: string): Promise<IUser | null | undefined>;
  findUserByEmail(email: string): Promise<IUser | null | undefined>;
  findAllUsers(query: UserRequestQuery): Promise<PaginatedResponse<IUser>>;
  deleteUser(id: string): Promise<IUser>;
  addUser(data: IUser): Promise<IUser>;
}
