import { injectable } from "inversify";
import { IPermission } from "../../../../../entities";
import { IPermissionRepository } from "./IPermissionRepository";
import Permission, { PermissionMapper } from "../../models/permission";

@injectable()
export class PermissionRepositoryImpl implements IPermissionRepository {
  async add(data: IPermission): Promise<IPermission | null> {
    try {
      const newPermission = new Permission(data);
      await newPermission.save();
      if (!newPermission) return null;
      return PermissionMapper.toEntity(newPermission);
    } catch (error) {
      throw error;
    }
  }
  async findOne(name: string): Promise<IPermission | null> {
    try {
      const permission = await Permission.findOne({ name: name });
      if (!permission) return null;
      return PermissionMapper.toEntity(permission);
    } catch (error) {
      throw error;
    }
  }
  async findAll(): Promise<IPermission[]> {
    try {
      const permissions = await Permission.find({});
      const data: IPermission[] = permissions.map((permission) =>
        PermissionMapper.toEntity(permission)
      );
      return data;
    } catch (error) {
      throw error;
    }
  }
}
