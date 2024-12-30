import { IPermission } from "../../../entities/Permission";
import { PermissionType } from "../../../utils";

export interface IPermissionInteractor {
  uploadPermissions(): Promise<IPermission[]>;
  getAllPermissions(): Promise<IPermission[]>;
}
