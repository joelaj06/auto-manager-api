import mongoose, { Model } from "mongoose";
import { IPermission } from "../../../../entities";

const permissionSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
  },
});

export const createPermissionModel = (
  connection: mongoose.Connection | mongoose.Mongoose = mongoose,
): Model<any> => {
  const modelName = "Permission";
  const targetConnection =
    connection instanceof mongoose.Mongoose
      ? connection
      : (connection as mongoose.Connection);
  const existingModel = targetConnection.models[modelName];
  if (existingModel) return existingModel as Model<any>;
  return targetConnection.model(modelName, permissionSchema);
};

const Permission = createPermissionModel();
export default Permission;

export const PermissionMapper = {
  toEntity: (model: any) => {
    return new IPermission(model.name, model._id?.toString());
  },
};
