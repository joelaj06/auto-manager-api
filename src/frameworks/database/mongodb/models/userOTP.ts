import mongoose from "mongoose";
import { IUserOTP } from "../../../../entities/UserOTP";

const userOTPSchema = new mongoose.Schema(
  {
    otp: Number,
    createdAt: Date,
    expiresAt: Date,
    user: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

const UserOTP = mongoose.model("UserOTP", userOTPSchema);
export default UserOTP;

export const OTPMapper = {
  /**
   * Convert the object with the OTP creation parameters to a format usable for creating a new OTP entry
   *
   */
  toDtoCreation: (payload: IUserOTP) => {
    return {
      otp: payload.otp,
      user: new mongoose.SchemaTypes.ObjectId(payload.user!), // Ensure user ID is converted to ObjectId
      expiresAt: payload.expiresAt,
    };
  },

  /**
   * Transform the query object into a MongoDB-compatible query.
   *
   */
  toQuery: (query: IUserOTP) => {
    return {
      ...(query.otp && { otp: query.otp }),
      ...(query.expiresAt && { expiresAt: query.expiresAt }),
      ...(query.user && {
        user: new mongoose.SchemaTypes.ObjectId(query.user),
      }),
      ...(query.createdAt && { createdAt: query.createdAt }),
    };
  },

  /**
   * Convert the MongoDB document (model) into an IUserOTP entity.
   *
   */
  toEntity: (model: any): IUserOTP => {
    return new IUserOTP(
      model.otp,
      model.expiresAt,
      model.user.toString(), // Convert ObjectId to string
      model.createdAt,
      model._id?.toString() // Optional _id, converted to string
    );
  },
};
