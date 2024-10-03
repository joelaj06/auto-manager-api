import { injectable } from "inversify";
import { IUserRepository } from "../../../../application/interface/IUserRepository";
import { IUser } from "../../../../entities/User";
import User, { UserMapper } from "../models/user";

@injectable()
export class UserRepositoryImpl implements IUserRepository {
  async findUserById(id: string): Promise<IUser> {
    const user = await User.findById(id);
    if (user) {
      return UserMapper.toEntity(user);
    } else {
      throw new Error("User not found");
    }
  }
  async updateUser(data: IUser): Promise<IUser> {
    const updatedUser = await User.findOneAndUpdate({ _id: data._id }, data, {
      new: true,
    });

    if (updatedUser) {
      return UserMapper.toEntity(updatedUser);
    } else {
      throw new Error("User not found");
    }
  }
}
