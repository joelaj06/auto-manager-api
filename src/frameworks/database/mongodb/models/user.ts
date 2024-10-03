import mongoose from "mongoose";
import { IUser } from "../../../../entities/User";

const userSchema = new mongoose.Schema(
  {
    firstName: String,
    lastName: String,
    email: String,
    password: String,
    phone: String,
    imageUrl: String,
    role: {
      type: String,
      enum: ["admin", "driver"],
    },
    company: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: "Company",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

const User = mongoose.model("User", userSchema);
export default User;

export const UserMapper = {
  /**
   * Convert the object with the User creation parameters to a format usable for creating a new User entry.
   * This ensures fields like `company` are stored as ObjectId.
   */
  toDtoCreation: (payload: IUser) => {
    return {
      firstName: payload.firstName,
      lastName: payload.lastName,
      email: payload.email,
      password: payload.password, // Optional field
      phone: payload.phone,
      imageUrl: payload.imageUrl,
      role: payload.role,
      company: new mongoose.SchemaTypes.ObjectId(payload.company ?? ""), // Ensure company is converted to ObjectId
      isActive: payload.isActive,
      status: payload.status,
      isVerified: payload.isVerified,
      token: payload.token, // Optional field
    };
  },

  /**
   * Transform the query object into a MongoDB-compatible query.
   * It dynamically adds filters based on the fields provided.
   */
  toQuery: (query: Partial<IUser>) => {
    return {
      ...(query.firstName && { firstName: query.firstName }),
      ...(query.lastName && { lastName: query.lastName }),
      ...(query.email && { email: query.email }),
      ...(query.phone && { phone: query.phone }),
      ...(query.role && { role: query.role }),
      ...(query.isActive !== undefined && { isActive: query.isActive }),
      ...(query.status && { status: query.status }),
      ...(query.isVerified !== undefined && { isVerified: query.isVerified }),
      ...(query.company && {
        company: new mongoose.SchemaTypes.ObjectId(query.company),
      }),
      ...(query.createdAt && { createdAt: query.createdAt }),
      ...(query.updatedAt && { updatedAt: query.updatedAt }),
      ...(query._id && { _id: new mongoose.SchemaTypes.ObjectId(query._id) }),
    };
  },

  /**
   * Convert the MongoDB document (model) into an IUser entity.
   * Converts fields like ObjectId and optional fields to a more suitable format.
   */
  toEntity: (model: any): IUser => {
    return new IUser(
      model._id?.toString(), // Convert ObjectId to string
      model.firstName,
      model.lastName,
      model.email,
      model.phone,
      model.role,
      model.isActive,
      model.isVerified,
      model.imageUrl,
      model.company?.toString(), // Convert ObjectId to string
      model.status,
      model.createdAt,
      model.updatedAt,
      model.password, // Optional field
      model.token // Optional field
    );
  },
};
