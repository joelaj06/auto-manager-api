import { injectable } from "inversify";
import { IUser } from "../../../../../entities/User";
import { NotFoundError } from "../../../../../error_handler";
import User, { UserMapper } from "../../models/user";
import { IUserRepository } from "./IUserRepository";

@injectable()
export class UserRepositoryImpl implements IUserRepository {
  async findUserByEmail(email: string): Promise<IUser> {
    try {
      const user = await User.findOne({ email: email });
      if (user) {
        return UserMapper.toEntity(user);
      } else {
        throw new NotFoundError("User not found");
      }
    } catch (error) {
      throw error;
    }
  }
  async findUserById(id: string): Promise<IUser> {
    const user = await User.findById(id);
    if (user) {
      return UserMapper.toEntity(user);
    } else {
      throw new NotFoundError("User not found");
    }
  }
  async updateUser(data: IUser): Promise<IUser> {
    const updatedUser = await User.findOneAndUpdate({ _id: data._id }, data, {
      new: true,
    });

    if (updatedUser) {
      return UserMapper.toEntity(updatedUser);
    } else {
      throw new NotFoundError("User not found");
    }
  }
}
