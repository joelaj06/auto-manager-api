import { injectable } from "inversify";
import { IAuthRepository } from "../../../../application/interface/IAuthRepository";
import { IUser } from "../../../../entities/User";
import User from "../models/user";

@injectable()
export class AuthRepositoryImpl implements IAuthRepository {
  async registerUser(data: IUser): Promise<IUser> {
    const user = await User.findOne({ email: data.email });
    if (user) {
      throw new Error("The email already exists");
    }
    const newUser = new User(data);
    await newUser.save();
    // Map the Mongoose document to IUser format
    const result: IUser = {
      _id: newUser._id.toString(), // Convert ObjectId to string if necessary
      createdAt: newUser.createdAt,
      updatedAt: newUser.updatedAt,
      isActive: newUser.isActive,
      status: newUser.status,
      role: newUser.role || "admin",
      isVerified: newUser.isVerified,
      imageUrl: newUser.imageUrl || "",
      firstName: newUser.firstName || "",
      lastName: newUser.lastName || "",
      email: newUser.email || "",
      phone: newUser.phone || "",
      company: newUser.company ? newUser.company.toString() : "", // If company is an ObjectId
    };

    return result;
  }
}
