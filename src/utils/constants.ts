export const INTERFACE_TYPE = {
  AuthMiddleware: Symbol.for("AuthMiddleware"),
  CompanyRepositoryImpl: Symbol.for("CompanyRepositoryImpl"),
  CompanyInteractorImpl: Symbol.for("CompanyInteractorImpl"),
  CompanyController: Symbol.for("CompanyController"),
  UserController: Symbol.for("UserController"),
  UserInteractor: Symbol.for("UserInteractor"),
  AuthRepositoryImpl: Symbol.for("AuthRepositoryImpl"),
  AuthServiceImpl: Symbol.for("AuthServiceImpl"),
  AuthInteractorImpl: Symbol.for("AuthInteractorImpl"),
  AuthController: Symbol.for("AuthController"),
  Mailer: Symbol.for("Mailer"),
  UserRepositoryImpl: Symbol.for("UserRepositoryImpl"),
  MailerImpl: Symbol.for("MailerImpl"),
  Logger: Symbol.for("Logger"),
  ErrorHandler: Symbol.for("ErrorHandler"),
  ErrorMiddleWare: Symbol.for("ErrorMiddleWare"),
  VehicleRepositoryImpl: Symbol.for("VehicleRepositoryImpl"),
  VehicleInteractorImpl: Symbol.for("VehicleInteractorImpl"),
  VehicleController: Symbol.for("VehicleController"),
  DriverRepositoryImpl: Symbol.for("DriverRepositoryImpl"),
  DriverInteractorImpl: Symbol.for("DriverInteractorImpl"),
  DriverController: Symbol.for("DriverController"),
  SalesRepositoryImpl: Symbol.for("SalesRepositoryImpl"),
  SalesInteractorImpl: Symbol.for("SalesInteractorImpl"),
  SalesController: Symbol.for("SalesController"),
  ExpenseCategoryRepositoryImpl: Symbol.for("ExpenseCategoryRepositoryImpl"),
  ExpenseCategoryInteractorImpl: Symbol.for("ExpenseCategoryInteractorImpl"),
  ExpenseCategoryController: Symbol.for("ExpenseCategoryController"),
  ExpenseRepositoryImpl: Symbol.for("ExpenseRepositoryImpl"),
  ExpenseInteractorImpl: Symbol.for("ExpenseInteractorImpl"),
  ExpenseController: Symbol.for("ExpenseController"),
  RentalRepositoryImpl: Symbol.for("RentalRepositoryImpl"),
  RentalInteractorImpl: Symbol.for("RentalInteractorImpl"),
  RentalController: Symbol.for("RentalController"),
  CustomerRepositoryImpl: Symbol.for("CustomerRepositoryImpl"),
  CustomerInteractorImpl: Symbol.for("CustomerInteractorImpl"),
  CustomerController: Symbol.for("CustomerController"),
  StorageBucketImpl: Symbol.for("StorageBucketImpl"),
  DashboardInteractorImpl: Symbol.for("DashboardInteractorImpl"),
  DashboardController: Symbol.for("DashboardController"),
  DashboardRepositoryImpl: Symbol.for("DashboardRepositoryImpl"),
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
  UNPROCESSABLE_ENTITY = 422,
  CONFLICT = 409,
}
