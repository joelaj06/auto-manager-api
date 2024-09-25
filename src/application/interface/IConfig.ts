export interface IConfig {
  port: number;
  mongo: {
    uri: string;
  };
  jwtSecret: string;
  mailerAppPassword: string;
  mailerEmail: string;
  mailerPort: number;
  mailerService: string;
  mailerHost: string;
}
