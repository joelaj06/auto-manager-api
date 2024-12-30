// main entry
import "reflect-metadata";
import express from "express";

import config from "./config/config";
import mongoose from "mongoose";

import cors from "cors";
import { Container } from "inversify";
import { ErrorHandlerImpl, IErrorHandler } from "./error_handler";
import { INTERFACE_TYPE } from "./utils";
import {
  authRoutes,
  AuthServiceImpl,
  companyRoutes,
  customerRoutes,
  dashboardRoutes,
  driverRoutes,
  ErrorMiddleware,
  expenseRoutes,
  ILogger,
  LoggerImpl,
  rentalRoutes,
  saleRoutes,
  userRoutes,
  vehicleRoutes,
  roleRoutes,
  permissionRoutes,
} from "./frameworks";
import expressConfig from "./frameworks/webserver/express";
import connection from "./frameworks/database/mongodb/connection";
import serverConfig from "./frameworks/webserver/server";
import { IAuthService } from "./frameworks/services/auth/IAuthService";
import { IStorageBucket } from "./frameworks/services/bucket/IStorageBucket";
import { CloudinaryImpl } from "./frameworks/services/bucket/CloudinaryImpl";

const app = express();
const container = new Container();

//TODO Bind dependecies in a single inversify container
container.bind<IErrorHandler>(INTERFACE_TYPE.ErrorHandler).to(ErrorHandlerImpl);

container
  .bind<IAuthService>(INTERFACE_TYPE.AuthServiceImpl)
  .to(AuthServiceImpl);

container
  .bind<ErrorMiddleware>(INTERFACE_TYPE.ErrorMiddleWare)
  .to(ErrorMiddleware);
//logger
container.bind<ILogger>(INTERFACE_TYPE.Logger).to(LoggerImpl);
//storagebucket
container
  .bind<IStorageBucket>(INTERFACE_TYPE.StorageBucketImpl)
  .to(CloudinaryImpl);

const bucket = container.get<IStorageBucket>(INTERFACE_TYPE.StorageBucketImpl);
const errorMiddleware = container.get<ErrorMiddleware>(
  INTERFACE_TYPE.ErrorMiddleWare
);

// express.js configuration (middlewares etc.)
expressConfig(app);
// Enable CORS for all requests

app.use(cors());

//routes
app.use(authRoutes);
app.use(userRoutes);
app.use(companyRoutes);
app.use(vehicleRoutes);
app.use(driverRoutes);
app.use(saleRoutes);
app.use(expenseRoutes);
app.use(rentalRoutes);
app.use(customerRoutes);
app.use(dashboardRoutes);
app.use(roleRoutes);
app.use(permissionRoutes);

//error middleware
app.use(errorMiddleware.execute().bind(errorMiddleware));

connection(mongoose, config).connectToMongo();
serverConfig(app, config).startServer();
bucket.configureStorageBucket();
