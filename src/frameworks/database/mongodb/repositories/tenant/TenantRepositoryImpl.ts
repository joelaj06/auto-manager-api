// frameworks/database/mongodb/repositories/tenant/TenantRepositoryImpl.ts
import { injectable } from "inversify";
import {
  ITenant,
  PaginatedResponse,
  RequestQuery,
} from "../../../../../entities";

import { ITenantRepository } from "./ITenantRepository";
import { NotFoundError, BadRequestError } from "../../../../../error_handler";
import { getTenantModels } from "../../../tenant-context/TenantContextStorage";
import { TenantMapper } from "../../system/TenantSystemModel";
import { Types } from "mongoose";

@injectable()
export class TenantRepositoryImpl implements ITenantRepository {
  async findTenantBySlug(slug: string): Promise<ITenant | null> {
    const { Tenant } = getTenantModels();
    const tenant = await Tenant.findOne({ slug, isDeleted: { $ne: true } });
    return tenant ? TenantMapper.toEntity(tenant) : null;
  }

  async findTenantById(id: string): Promise<ITenant | null> {
    const { Tenant } = getTenantModels();
    const tenant = await Tenant.findById(id);
    return tenant ? TenantMapper.toEntity(tenant) : null;
  }

  async findAllTenants(
    query: RequestQuery,
  ): Promise<PaginatedResponse<ITenant>> {
    const { Tenant } = getTenantModels();
    const searchQuery = query.search || "";
    const limit = query.pageSize || 10;
    const pageIndex = query.pageIndex || 1;
    const startIndex = (pageIndex - 1) * limit;

    const searchCriteria = {
      isDeleted: { $ne: true },
      ...(searchQuery && {
        $or: [
          { name: { $regex: new RegExp(`^${searchQuery}.*`, "i") } },
          { slug: { $regex: new RegExp(`^${searchQuery}.*`, "i") } },
        ],
      }),
    };

    const tenants = await Tenant.find(searchCriteria)
      .limit(limit)
      .skip(startIndex);
    const totalCount = await Tenant.countDocuments(searchCriteria);

    return {
      data: tenants.map((t) => TenantMapper.toEntity(t)),
      totalPages: Math.ceil(totalCount / limit),
      totalCount,
      pageCount: pageIndex,
    };
  }

  async createTenant(data: Partial<ITenant>): Promise<ITenant> {
    const { Tenant } = getTenantModels();
    const dto = TenantMapper.toDtoCreation(data);
    const tenant = new Tenant(dto);
    await tenant.save();
    return TenantMapper.toEntity(tenant);
  }

  async updateTenant(id: string, data: Partial<ITenant>): Promise<ITenant> {
    const { Tenant } = getTenantModels();
    const updated = await Tenant.findByIdAndUpdate(
      id,
      { ...data, updatedAt: new Date() },
      { new: true },
    );
    if (!updated) throw new NotFoundError("Tenant not found");
    return TenantMapper.toEntity(updated);
  }

  async softDeleteTenant(id: string): Promise<void> {
    const { Tenant } = getTenantModels();
    const result = await Tenant.findByIdAndUpdate(id, { isDeleted: true });
    if (!result) throw new NotFoundError("Tenant not found");
  }
}
