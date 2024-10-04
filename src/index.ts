// main entry
import "reflect-metadata";
import express from "express";
import expressConfig from "./frameworks/webserver/express";

import connection from "./frameworks/database/mongodb/connection";
import serverConfig from "./frameworks/webserver/server";
import config from "./config/config";
import mongoose from "mongoose";
import { authRoutes } from "./frameworks/webserver/routes";
import cors from "cors";
import { Container } from "inversify";
import {
  ERROR_HANDLER_TYPE,
  ErrorHandlerImpl,
  IErrorHandler,
} from "./error_handler";
import { ILogger, LOGGER_TYPE, LoggerImpl } from "./frameworks/logging";
import { ErrorMiddleware } from "./frameworks/webserver/middleware";

const app = express();
const container = new Container();

container
  .bind<IErrorHandler>(ERROR_HANDLER_TYPE.ErrorHandler)
  .to(ErrorHandlerImpl);

container
  .bind<ErrorMiddleware>(ERROR_HANDLER_TYPE.ErrorMiddleWare)
  .to(ErrorMiddleware);
//logger
container.bind<ILogger>(LOGGER_TYPE.Logger).to(LoggerImpl);

const errorMiddleware = container.get<ErrorMiddleware>(
  ERROR_HANDLER_TYPE.ErrorMiddleWare
);

// express.js configuration (middlewares etc.)
expressConfig(app);
// Enable CORS for all requests

app.use(cors());

//routes
app.use(authRoutes);

//error middleware
app.use(errorMiddleware.execute());

connection(mongoose, config).connectToMongo();

serverConfig(app, config).startServer();
