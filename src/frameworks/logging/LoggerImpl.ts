import winston from "winston";
import dotenv from "dotenv";
import { ILogger } from "./ILogger";
import { injectable } from "inversify";

const customLevels = {
  levels: {
    trace: 5,
    debug: 4,
    info: 3,
    warn: 2,
    error: 1,
    fatal: 0,
  },
  colors: {
    trace: "white",
    debug: "green",
    info: "green",
    warn: "yellow",
    error: "red",
    fatal: "red",
  },
};

const formatter = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.splat(),
  winston.format.printf((info) => {
    const { timestamp, level, message, ...meta } = info;

    return `${timestamp} [${level}]: ${message} ${
      Object.keys(meta).length ? JSON.stringify(meta, null, 2) : ""
    }`;
  })
);

dotenv.config();

@injectable()
export class LoggerImpl implements ILogger {
  private logger: winston.Logger;

  constructor() {
    const prodTransport = new winston.transports.File({
      filename: "logs/error.log",
      level: "error",
    });
    const transport = new winston.transports.Console({
      format: formatter,
    });
    this.logger = winston.createLogger({
      level: process.env.NODE_ENV === "development" ? "trace" : "error",
      levels: customLevels.levels,
      transports: [
        process.env.NODE_ENV === "development" ? transport : prodTransport,
      ],
    });
    winston.addColors(customLevels.colors);
  }
  log(level: string, message: string, meta?: unknown): void {
    this.logger.log(level, message, meta);
  }

  trace(msg: any, meta?: any) {
    this.logger.log("trace", msg, meta);
  }

  debug(msg: any, meta?: any) {
    this.logger.debug(msg, meta);
  }

  info(msg: any, meta?: any) {
    this.logger.info(msg, meta);
  }

  warn(msg: any, meta?: any) {
    this.logger.warn(msg, meta);
  }

  error(msg: any, meta?: any) {
    this.logger.error(msg, meta);
  }

  fatal(msg: any, meta?: any) {
    this.logger.log("fatal", msg, meta);
  }
}

export const logger = new LoggerImpl();
