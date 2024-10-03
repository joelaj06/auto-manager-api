export class IUserOTP {
  constructor(
    public readonly otp?: number | null | undefined,
    public readonly expiresAt?: Date,
    public readonly user?: string,
    public readonly createdAt?: Date,
    public readonly _id?: string
  ) {}
}
