import { Container } from "inversify";
import { ErrorHandlerImpl, IErrorHandler } from "../../error_handler";
import { INTERFACE_TYPE } from "../../utils/constants";
import { ILogger, LoggerImpl } from "../logging";
import { AuthServiceImpl, IStorageBucket, CloudinaryImpl } from "../services";
import { IAuthService } from "../services/auth/IAuthService";
import { ErrorMiddleware } from "./middleware";

const container = new Container();

container.bind<IErrorHandler>(INTERFACE_TYPE.ErrorHandler).to(ErrorHandlerImpl);
container
  .bind<IAuthService>(INTERFACE_TYPE.AuthServiceImpl)
  .to(AuthServiceImpl);
container
  .bind<ErrorMiddleware>(INTERFACE_TYPE.ErrorMiddleWare)
  .to(ErrorMiddleware);
container.bind<ILogger>(INTERFACE_TYPE.Logger).to(LoggerImpl);
container
  .bind<IStorageBucket>(INTERFACE_TYPE.StorageBucketImpl)
  .to(CloudinaryImpl);

export { container };
