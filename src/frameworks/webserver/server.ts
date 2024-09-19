//handle server configs here

import { Express } from "express";
import { IConfig } from "../../application/interface/IConfig";
const serverConfig = (app: Express, config: IConfig) => {
  const startServer = () => {
    app.listen(config.port, () => {
      console.log(`Server listening on Port ${config.port}`);
    });
  };
  return { startServer };
};

export default serverConfig;
