import { IPermission } from "../../../../../entities";

export interface IPermissionRepository {
  add(data: IPermission): Promise<IPermission | null>;
  findOne(name: string): Promise<IPermission | null>;
  findAll(): Promise<IPermission[]>;
}
