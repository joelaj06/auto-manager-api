// main entry
import "reflect-metadata";
import express from "express";
import expressConfig from "./frameworks/webserver/express";

import connection from "./frameworks/database/mongodb/connection";
import serverConfig from "./frameworks/webserver/server";
import config from "./config/config";
import mongoose from "mongoose";
import { authRoutes } from "./frameworks/webserver/routes";

const app = express();
// express.js configuration (middlewares etc.)
expressConfig(app);

//routes
app.use(authRoutes);

connection(mongoose, config).connectToMongo();

serverConfig(app, config).startServer();
