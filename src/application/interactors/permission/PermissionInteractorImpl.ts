import { inject, injectable } from "inversify";
import { IPermission } from "../../../entities";
import {
  INTERFACE_TYPE,
  Permissions,
  PermissionType,
  UserPermissions,
} from "../../../utils";
import { IPermissionInteractor } from "./IPermissionInteractor";
import { IPermissionRepository } from "../../../frameworks/database/mongodb/repositories/permission";
import { ILogger, PermissionMapper } from "../../../frameworks";

@injectable()
export class PermissionInteractorImpl implements IPermissionInteractor {
  private permissionRepository: IPermissionRepository;
  private logger: ILogger;
  constructor(
    @inject(INTERFACE_TYPE.PermissionRepositoryImpl)
    permissionRepository: IPermissionRepository,
    @inject(INTERFACE_TYPE.Logger) logger: ILogger
  ) {
    this.permissionRepository = permissionRepository;
    this.logger = logger;
  }
  async uploadPermissions(): Promise<IPermission[]> {
    const permissions = Object.values(UserPermissions).map(async (name) => {
      let permission = await this.permissionRepository.findOne(name);
      if (!permission) {
        permission = await this.permissionRepository.add({ name: name });
        console.info(`Added permission: ${name} ⭐`);
      } else {
        console.info(`Permission ${name} already exists`);
      }
      return permission;
    });
    console.info("Permissions uploaded");
    return permissions.map((permission) =>
      PermissionMapper.toEntity(permission)
    );
  }
  async getAllPermissions(): Promise<IPermission[]> {
    const permissions = await this.permissionRepository.findAll();
    return permissions.map((permission) =>
      PermissionMapper.toEntity(permission)
    );
  }
}
