import express from "express";
import cors from "cors";
import { INTERFACE_TYPE } from "../../utils/constants";
import expressConfig from "./express";
import { ErrorMiddleware } from "./middleware";
import routes from "./routes";
import { container } from "./container";

export const createApp = () => {
  const app = express();

  // Configure express (middlewares, body parser, etc.)
  expressConfig(app);
  app.use(
    cors({
      origin: "*",
      exposedHeaders: [
        "x-pagination",
        "_meta_total_sales",
        "_meta_total_rentals",
        "_meta_total_expenses",
      ],
    }),
  );

  // Routes
  app.use(routes);

  // Error middleware
  const errorMiddleware = container.get<ErrorMiddleware>(
    INTERFACE_TYPE.ErrorMiddleWare,
  );
  app.use(errorMiddleware.execute().bind(errorMiddleware));

  return app;
};
