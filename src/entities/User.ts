export class IUser {
  constructor(
    public readonly _id?: string,
    public readonly firstName?: string,
    public readonly lastName?: string,
    public readonly email?: string,
    public readonly phone?: string,
    public readonly role?: string,
    public readonly isActive?: boolean,
    public readonly isVerified?: boolean,
    public readonly imageUrl?: string,
    public readonly company?: string,
    public readonly status?: string,
    public readonly createdAt?: Date,
    public readonly updatedAt?: Date,
    public readonly password?: string,
    public readonly token?: string,
    public readonly deviceToken?: string
  ) {}
}
