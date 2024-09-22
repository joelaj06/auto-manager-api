export interface IConfig {
  port: number;
  mongo: {
    uri: string;
  };
  jwtSecret: string;
}
