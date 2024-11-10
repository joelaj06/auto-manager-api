import { IUser } from "./User";

export class UserRegistrationResponse {
  constructor(
    public readonly status: string,
    public readonly message: string,
    public readonly data?: UserRegistrationResponseData
  ) {}
}

class UserRegistrationResponseData {
  constructor(userId: string, email: string) {}
}

export class UserOTPResponse {
  constructor(
    public readonly status: string,
    public readonly message: string,
    public readonly data?: IUser | UserRegistrationResponseData
  ) {}
}

export class PaginatedResponse<T> {
  constructor(
    public readonly data: T[],
    public readonly pageCount: number,
    public readonly totalCount: number,
    public readonly totalPages: number,
    public readonly totalSum?: number
  ) {}
}
