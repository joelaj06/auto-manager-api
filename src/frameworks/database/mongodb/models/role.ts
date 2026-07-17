import mongoose, { Model } from "mongoose";
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
      required: false,
      unique: false,
    },
    permissions: {
      type: Array,
      default: [],
    },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
  },
  { timestamps: true },
);

export const createRoleModel = (
  connection: mongoose.Connection | mongoose.Mongoose = mongoose,
): Model<any> => {
  const modelName = "Role";
  const targetConnection =
    connection instanceof mongoose.Mongoose
      ? connection
      : (connection as mongoose.Connection);
  const existingModel = targetConnection.models[modelName];
  if (existingModel) return existingModel as Model<any>;
  return targetConnection.model(modelName, roleSchema);
};

const Role = createRoleModel();
export default Role;

//create role mapper
export const RoleMapper = {
  toEntity: (model: any): IRole => {
    return new IRole(
      model._id?.toString(),
      model.name,
      model.description,
      model.companyId.toString(), // Convert ObjectId to string
      model.permissions,
    );
  },
};
