import { inject, injectable } from "inversify";
import { RequestQuery, IRole } from "../../../entities";
import { IRoleInteractor } from "./IRoleInteractor";
import { IRoleRepository } from "../../../frameworks";
import { RoleRepositoryImpl } from "../../../frameworks/database/mongodb/repositories/role/RoleRepositoryImpl";
import { INTERFACE_TYPE } from "../../../utils";
import { BadRequestError, NotFoundError } from "../../../error_handler";

@injectable()
export class RoleInteractorImpl implements IRoleInteractor {
  private repository: IRoleRepository;

  constructor(
    @inject(INTERFACE_TYPE.RoleRepositoryImpl)
    roleRepository: RoleRepositoryImpl
  ) {
    this.repository = roleRepository;
  }
  async getARole(id: string): Promise<IRole | null | undefined> {
    if (!id) throw new BadRequestError("Role id is required");
    const role = await this.repository.getARole(id);
    if (!role) throw new NotFoundError("Role not found");
    return role;
  }
  async getRoles(query: RequestQuery): Promise<IRole[]> {
    return await this.repository.getAllRoles(query);
  }
  async addRole(data: IRole): Promise<IRole> {
    if (!data) throw new BadRequestError("Role data is required");
    const role = await this.repository.addRole(data);
    if (!role) throw new BadRequestError("Error adding role");
    return role;
  }
  async updateRole(id: string, data: IRole): Promise<IRole> {
    if (!id) throw new BadRequestError("Role id is required");
    const role = await this.repository.getARole(id);
    if (!role) throw new BadRequestError("Role not found");
    const updatedRole = await this.repository.updateRole(id, data);
    if (!updatedRole) throw new BadRequestError("Error updating role");
    return updatedRole;
  }
  async deleteRole(id: string): Promise<IRole> {
    if (!id) throw new BadRequestError("Role id is required");
    const role = await this.repository.getARole(id);
    if (!role) throw new BadRequestError("Role not found");
    const deletedRole = await this.repository.deleteRole(id);
    if (!deletedRole) throw new BadRequestError("Error deleting role");
    return deletedRole;
  }
}
