export class IUser {
  constructor(
    public readonly _id?: string,
    public readonly firstName?: string,
    public readonly lastName?: string,
    public readonly email?: string,
    public readonly phone?: string,
    public readonly role?: IRole,
    public readonly isActive?: boolean,
    public readonly isVerified?: boolean,
    public readonly imageUrl?: string,
    public readonly company?: string,
    public readonly status?: string,
    public readonly createdAt?: Date,
    public readonly updatedAt?: Date,
    public readonly password?: string,
    public readonly token?: string,
    public readonly deviceToken?: string,
    public readonly createdBy?: string,
    public readonly licenseNumber?: string,
    public readonly lisenceExpiryDate?: Date,
    public readonly vehicleId?: string,
    public readonly companyId?: string
  ) {}
}

export class IRole {
  constructor(
    public readonly _id?: string,
    public readonly name?: string,
    public readonly description?: string,
    public readonly companyId?: string,
    public readonly permissions?: string[] // Permissions granted to this role
  ) {}
}

export class UserPasswordChangeRequest {
  constructor(
    public readonly currentPassword: string,
    public readonly newPassword: string,
    public readonly userId: string
  ) {}
}

export interface UserRequest extends Request {
  user?: IUser;
}

export interface RequestQuery {
  search?: string;
  pageSize?: number;
  pageIndex?: number;
  startDate?: Date;
  endDate?: Date;
  status?: string;
  companyId?: string;
}
