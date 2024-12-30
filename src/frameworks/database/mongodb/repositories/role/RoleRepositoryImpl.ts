import mongoose from "mongoose";
import { RequestQuery, IRole } from "../../../../../entities";
import { IRoleRepository } from "./IRoleRepository";
import { injectable } from "inversify";
import Role, { RoleMapper } from "../../models/role";
import { BadRequestError, NotFoundError } from "../../../../../error_handler";

@injectable()
export class RoleRepositoryImpl implements IRoleRepository {
  async getARole(id: string): Promise<IRole | null | undefined> {
    try {
      const role = await Role.findById(id);
      if (!role) return null;
      return RoleMapper.toEntity(role);
    } catch (error) {
      throw error;
    }
  }
  async addRole(data: IRole): Promise<IRole | null | undefined> {
    try {
      const newRole = new Role(data);
      await newRole.save();
      if (!newRole) return null;
      return RoleMapper.toEntity(newRole);
    } catch (error) {
      throw error;
    }
  }
  async updateRole(id: string, data: IRole): Promise<IRole | null | undefined> {
    try {
      if (!id) throw new BadRequestError("Role id is required");
      if (!data) throw new BadRequestError("Role data is required");
      const updatedRole = await Role.findOneAndUpdate({ _id: id }, data, {
        new: true,
      });
      if (!updatedRole) return null;
      return RoleMapper.toEntity(updatedRole);
    } catch (error) {
      throw error;
    }
  }
  async deleteRole(id: string): Promise<IRole | null | undefined> {
    try {
      if (!id) throw new BadRequestError("Role id is required");
      const role = await Role.findById(id);
      if (!role) throw new NotFoundError("Role not found");
      await Role.findByIdAndUpdate(
        id,
        {
          isDeleted: true,
          deletedAt: new Date(),
        },
        {
          new: true,
        }
      );
      return RoleMapper.toEntity(role);
    } catch (error) {
      throw error;
    }
  }
  async getAllRoles(query: RequestQuery): Promise<IRole[]> {
    try {
      const searchQuery = query.search || "";
      const companyId = query.companyId;

      let searchCriteria = {};

      if (companyId)
        searchCriteria = {
          ...searchCriteria,
          companyId: new mongoose.Types.ObjectId(companyId),
        };

      searchCriteria = {
        ...searchCriteria,
        $or: [
          { name: { $regex: new RegExp(`^${searchQuery}.*`, "i") } },
          { description: { $regex: new RegExp(`^${searchQuery}.*`, "i") } },
        ],
      };

      const roles = await Role.find(searchCriteria);
      if (roles) {
        return roles.map((role) => RoleMapper.toEntity(role));
      } else {
        throw new Error();
      }
    } catch (error) {
      throw error;
    }
  }
}
