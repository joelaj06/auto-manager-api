// configure ports and urls here with secrete keys
import dotenv from "dotenv";
import { IConfig } from "../application/interface/IConfig";

dotenv.config();
const config: IConfig = {
  port: Number(process.env.PORT) || 3000, // Convert the env variable to a number
  mongo: {
    uri:
      process.env.NODE_ENV === "production"
        ? process.env.MONGO_DB_URI || "" // Use production database URI
        : process.env.MONGO_DB_LOCAL_URI || "",
  },
  jwtSecret: process.env.JWT_SECRET || "secret",
  mailerAppPassword: process.env.GMAIL_APP_PASSWORD || "",
  mailerEmail: process.env.GMAIL_EMAIL || "",
  mailerService: process.env.MAIL_HOST || "smtp.gmail.com",
  mailerHost: process.env.MAIL_HOST || "smtp.gmail.com",
  mailerPort: Number(process.env.MAIL_PORT),
};

export default config;
