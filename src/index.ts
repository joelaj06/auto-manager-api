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
  ErrorMiddleware,
  ILogger,
  LoggerImpl,
  userRoutes,
} from "./frameworks";
import expressConfig from "./frameworks/webserver/express";
import connection from "./frameworks/database/mongodb/connection";
import serverConfig from "./frameworks/webserver/server";

const app = express();
const container = new Container();

//TODO Bind dependecies in a single inversify container
container.bind<IErrorHandler>(INTERFACE_TYPE.ErrorHandler).to(ErrorHandlerImpl);

container
  .bind<ErrorMiddleware>(INTERFACE_TYPE.ErrorMiddleWare)
  .to(ErrorMiddleware);
//logger
container.bind<ILogger>(INTERFACE_TYPE.Logger).to(LoggerImpl);

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

//error middleware
app.use(errorMiddleware.execute());

connection(mongoose, config).connectToMongo();

serverConfig(app, config).startServer();
