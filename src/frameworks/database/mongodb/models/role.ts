import mongoose from "mongoose";
import { IRole } from "../../../../entities/User";

const roleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    description: {
      type: String,
    },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      unique: false,
    },
    permissions: {
      type: Array,
      default: [],
    },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
  },
  { timestamps: true }
);

const Role = mongoose.model("Role", roleSchema);
export default Role;

//create role mapper
export const RoleMapper = {
  toEntity: (model: any): IRole => {
    return new IRole(
      model._id?.toString(),
      model.name,
      model.description,
      model.companyId.toString(), // Convert ObjectId to string
      model.permissions
    );
  },
};
