import type { TenantUser, TenantUserStatus } from "../entities/TenantUser.js";

export type UserListQuery = Readonly<{
  /** Only users who belong to one of these branches; "all": no branch restriction. */
  branchIds: "all" | readonly string[];
  /** Also include this user (own-scope access to oneself). */
  includeUserId?: string;
  status?: TenantUserStatus;
  search?: string;
  limit: number;
  before?: string;
}>;

/** Users of the current tenant (tenant unit of work). */
export interface ITenantUserRepository {
  findById(id: string): Promise<TenantUser | null>;
  lockById(id: string): Promise<TenantUser | null>;
  findByEmail(email: string): Promise<TenantUser | null>;
  findByPhone(phone: string): Promise<TenantUser | null>;
  /** Inserts or updates. */
  save(user: TenantUser, invitedBy?: string | null): Promise<void>;
  list(query: UserListQuery): Promise<TenantUser[]>;
}
