import { injectable } from "inversify";
import { IUserRepository } from "../../../../application/interface/IUserRepository";
import { IUser } from "../../../../entities/User";
import User, { UserMapper } from "../models/user";
import { NotFoundError } from "../../../../error_handler";

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
      //throw new Error(`${error}`);
      throw error;
    }
  }
  async findUserById(id: string): Promise<IUser> {
    const user = await User.findById(id).select("-password");
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
