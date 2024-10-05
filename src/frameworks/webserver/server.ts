//handle server configs here

import { Express } from "express";
import { IConfig } from "../../config/IConfig";
const serverConfig = (app: Express | any, config: IConfig) => {
  const startServer = () => {
    app.listen(config.port, () => {
      console.log(`Server listening on Port ${config.port}`);
    });
  };
  return { startServer };
};

export default serverConfig;
