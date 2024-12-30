import { injectable } from "inversify";
import { IUser, RequestQuery } from "../../../../../entities/User";
import { NotFoundError } from "../../../../../error_handler";
import User, { UserMapper } from "../../models/user";
import { IUserRepository } from "./IUserRepository";
import { PaginatedResponse } from "../../../../../entities/UserResponse";
import { UnprocessableEntityError } from "../../../../../error_handler/UnprocessableEntityError";
import mongoose from "mongoose";

@injectable()
export class UserRepositoryImpl implements IUserRepository {
  async deleteUser(id: string): Promise<IUser> {
    try {
      if (!id) throw new UnprocessableEntityError("User id is required");
      const user = await User.findById(id);
      if (!user) throw new NotFoundError("User not found");
      await User.findByIdAndUpdate(
        id,
        {
          isDeleted: true,
          deletedAt: new Date(),
        },
        {
          new: true,
        }
      );
      return UserMapper.toEntity(user);
    } catch (error) {
      throw error;
    }
  }
  async addUser(data: IUser): Promise<IUser> {
    try {
      if (!data) throw new UnprocessableEntityError("User data is required");
      const newUser = new User(data);
      await newUser.save();
      return UserMapper.toEntity(newUser);
    } catch (error) {
      throw error;
    }
  }
  async findAllUsers(query: RequestQuery): Promise<PaginatedResponse<IUser>> {
    try {
      const searchQuery = query.search || "";
      const limit = query.pageSize || 10;
      const pageIndex = query.pageIndex || 1;
      const startIndex = (pageIndex - 1) * limit;
      const companyId = query.companyId;

      let searchCriteria = {};

      if (companyId)
        searchCriteria = {
          ...searchCriteria,
          company: new mongoose.Types.ObjectId(companyId),
        };

      searchCriteria = {
        ...searchCriteria,
        $or: [
          { firstName: { $regex: new RegExp(`^${searchQuery}.*`, "i") } },
          { lastName: { $regex: new RegExp(`^${searchQuery}.*`, "i") } },
          { email: { $regex: new RegExp(`^${searchQuery}.*`, "i") } },
        ],
      };

      const users = await User.find(searchCriteria)
        .select("-password")
        .populate("role")
        .limit(limit)
        .skip(startIndex);

      if (users) {
        const data: IUser[] = users.map((user) => UserMapper.toEntity(user));
        const totalCount: number = await User.countDocuments(searchCriteria);
        // Calculate total pages
        const totalPages = Math.ceil(totalCount / limit);
        const paginatedRes: PaginatedResponse<IUser> = {
          data,
          totalPages,
          totalCount,
          pageCount: pageIndex,
        };
        return paginatedRes;
      } else {
        throw new Error();
      }
    } catch (error) {
      throw error;
    }
  }
  async findUserByEmail(email: string): Promise<IUser | null | undefined> {
    try {
      const user = await User.findOne({ email: email }).populate("role");
      if (user) {
        return UserMapper.toEntity(user);
      } else {
        return null;
      }
    } catch (error) {
      throw error;
    }
  }
  async findUserById(id: string): Promise<IUser | null | undefined> {
    const user = await User.findById(id);
    if (user) {
      return UserMapper.toEntity(user);
    } else {
      return null;
    }
  }
  async updateUser(id: string, data: IUser): Promise<IUser> {
    try {
      const updatedUser = await User.findOneAndUpdate({ _id: id }, data, {
        new: true,
      }).select("-password");

      if (updatedUser) {
        return UserMapper.toEntity(updatedUser);
      } else {
        throw new NotFoundError("User not found");
      }
    } catch (error) {
      throw error;
    }
  }
}
