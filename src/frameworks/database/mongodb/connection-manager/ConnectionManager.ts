import mongoose, { Connection, Mongoose } from "mongoose";
import config from "../../../../config/config";

export class ConnectionManager {
  private readonly systemUri: string;
  private systemConnection: Mongoose | null = null;
  private tenantConnections = new Map<string, Connection>();
  private idleTimers = new Map<string, NodeJS.Timeout>();

  constructor(uri: string = config.mongo.uri) {
    this.systemUri = uri;
  }

  async getSystemConnection(): Promise<Mongoose> {
    if (this.systemConnection?.connection.readyState === 1) {
      return this.systemConnection;
    }

    this.systemConnection = mongoose;
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(this.systemUri);
    }

    return this.systemConnection;
  }

  async getTenantConnection(tenant: {
    slug?: string;
    databaseName?: string;
    databaseUri?: string;
  }): Promise<Connection> {
    const connectionKey = tenant.databaseName || tenant.slug || "default";
    const cached = this.tenantConnections.get(connectionKey);
    if (cached?.readyState === 1) {
      return cached;
    }

    const uri = tenant.databaseUri || this.systemUri;
    const connection = await this.connect(uri, connectionKey);
    this.tenantConnections.set(connectionKey, connection);
    return connection;
  }

  async closeTenantConnection(connectionKey: string): Promise<void> {
    const connection = this.tenantConnections.get(connectionKey);
    if (connection) {
      await connection.close();
      this.tenantConnections.delete(connectionKey);
    }
  }

  private async connect(uri: string, name: string): Promise<Connection> {
    const connection = mongoose.createConnection(uri, {
      autoIndex: true,
      autoCreate: true,
      dbName: name,
    });

    await new Promise<void>((resolve, reject) => {
      connection.once("open", () => resolve());
      connection.once("error", (error) => reject(error));
    });

    return connection;
  }
}

export const connectionManager = new ConnectionManager();
