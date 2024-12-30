import { IRole, RequestQuery } from "../../../../../entities";

export interface IRoleRepository {
  getAllRoles(query: RequestQuery): Promise<IRole[]>;
  getARole(id: string): Promise<IRole | null | undefined>;
  addRole(data: IRole): Promise<IRole | null | undefined>;
  updateRole(id: string, data: IRole): Promise<IRole | null | undefined>;
  deleteRole(id: string): Promise<IRole | null | undefined>;
}
