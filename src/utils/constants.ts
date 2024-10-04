export const INTERFACE_TYPE = {
  AuthRepositoryImpl: Symbol.for("AuthRepositoryImpl"),
  AuthServiceImpl: Symbol.for("AuthServiceImpl"),
  AuthInteractorImpl: Symbol.for("AuthInteractorImpl"),
  AuthController: Symbol.for("AuthController"),
  Mailer: Symbol.for("Mailer"),
  UserRepositoryImpl: Symbol.for("UserRepositoryImpl"),
};

export enum HttpStatusCode {
  OK = 200,
  CREATED = 201,
  NO_CONTENT = 204,
  BAD_GATEWAY = 502,
  UNAUTHORIZED = 401,
  FORBIDDEN = 403,
  NOT_ACCEPTABLE = 406,
  BAD_REQUEST = 400,
  NOT_FOUND = 404,
  INTERNAL_SERVER_ERROR = 500,
}
