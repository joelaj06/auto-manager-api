import "reflect-metadata";
import mongoose from "mongoose";
import config from "./config/config";
import connection from "./frameworks/database/mongodb/connection";
import serverConfig from "./frameworks/webserver/server";
import { INTERFACE_TYPE } from "./utils/constants";
import { IStorageBucket } from "./frameworks/services/bucket/IStorageBucket";
import { createApp, container } from "./frameworks";

const app = createApp();

export default app; // Export app for testing purposes and vercel deployment

// Initialize external storage services
const bucket = container.get<IStorageBucket>(INTERFACE_TYPE.StorageBucketImpl);
bucket.configureStorageBucket();

// Start database and server
connection(mongoose, config).connectToMongo();
serverConfig(app, config).startServer();
