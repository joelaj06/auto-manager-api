// main entry
import express from "express";
import expressConfig from "./frameworks/webserver/express";

import connection from "./frameworks/database/mongodb/connection";
import serverConfig from "./frameworks/webserver/server";
import config from "./config/config";
import mongoose from "mongoose";

const app = express();
// express.js configuration (middlewares etc.)
expressConfig(app);

connection(mongoose, config).connectToMongo();

serverConfig(app, config).startServer();
