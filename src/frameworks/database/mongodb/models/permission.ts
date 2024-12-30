import mongoose from "mongoose";
import { IPermission } from "../../../../entities";

const permissionSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
  },
});

const Permission = mongoose.model("Permission", permissionSchema);

export default Permission;

export const PermissionMapper = {
  toEntity: (model: any) => {
    return new IPermission(model.name, model._id?.toString());
  },
};
