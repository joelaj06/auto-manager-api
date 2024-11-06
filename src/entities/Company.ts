export class ICompany {
  constructor(
    public readonly _id?: string,
    public readonly name?: string,
    public companyCode?: string,
    public readonly industry?: string,
    public readonly phone?: string,
    public readonly email?: string,
    public readonly website?: string,
    public readonly registrationNumber?: string,
    public readonly taxIdentificationNumber?: string,
    public readonly companyType?: string,
    public readonly isActive?: boolean,
    public readonly isVerified?: boolean,
    public readonly ownerId?: string,
    public readonly employeesCount?: number,
    public readonly logoUrl?: string,
    public readonly description?: string,
    public readonly subscriptionPlan?: string,
    public readonly createdAt?: Date,
    public readonly updatedAt?: Date,
    public readonly createdBy?: string,
    public readonly address?: IAddress
  ) {}
}

export class IAddress {
  constructor(
    public readonly street?: string,
    public readonly city?: string,
    public readonly state?: string,
    public readonly postalCode?: string,
    public readonly country?: string
  ) {}
}
