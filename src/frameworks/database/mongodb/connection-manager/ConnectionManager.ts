import mongoose, { Connection, Mongoose } from "mongoose";
import config from "../../../../config/config";

export class ConnectionManager {
  private readonly systemUri: string;
  private systemConnection: Mongoose | null = null;
  private tenantConnections = new Map<string, Connection>();
  private idleTimers = new Map<string, NodeJS.Timeout>();
  private systemConnectionPromise: Promise<Mongoose> | null = null;
  private connectingPromises = new Map<string, Promise<Connection>>();
  private readonly idleTimeoutMs = 30 * 60 * 1000; // 30 min
  constructor(uri: string = config.mongo.uri) {
    this.systemUri = uri;
  }

  async getSystemConnection(): Promise<Mongoose> {
    if (this.systemConnection?.connection.readyState === 1) {
      return this.systemConnection;
    }
    if (!this.systemConnectionPromise) {
      this.systemConnectionPromise = (async () => {
        this.systemConnection = mongoose;
        if (mongoose.connection.readyState !== 1) {
          await mongoose.connect(this.systemUri);
        }
        return this.systemConnection;
      })().finally(() => {
        this.systemConnectionPromise = null;
      });
    }
    return this.systemConnectionPromise;
  }

  async getTenantConnection(tenant: {
    slug?: string;
    databaseName?: string;
    databaseUri?: string;
  }): Promise<Connection> {
    const connectionKey = tenant.databaseName || tenant.slug || "default";

    const cached = this.tenantConnections.get(connectionKey);
    if (cached?.readyState === 1) {
      this.resetIdleTimer(connectionKey);
      return cached;
    }

    const inFlight = this.connectingPromises.get(connectionKey);
    if (inFlight) return inFlight;

    const uri = tenant.databaseUri || this.systemUri;
    const connectPromise = this.connect(uri, connectionKey)
      .then((connection) => {
        this.tenantConnections.set(connectionKey, connection);

        connection.on("error", (err) => {
          console.error(`Tenant connection error [${connectionKey}]:`, err);
        });
        connection.on("disconnected", () => {
          console.info(`Tenant connection disconnected [${connectionKey}]`);
          this.tenantConnections.delete(connectionKey);
          this.clearIdleTimer(connectionKey);
        });

        this.resetIdleTimer(connectionKey);
        return connection;
      })
      .finally(() => {
        this.connectingPromises.delete(connectionKey);
      });

    this.connectingPromises.set(connectionKey, connectPromise);
    return connectPromise;
  }

  async closeTenantConnection(connectionKey: string): Promise<void> {
    const connection = this.tenantConnections.get(connectionKey);
    if (connection) {
      await connection.close();
      this.tenantConnections.delete(connectionKey);
    }
    this.clearIdleTimer(connectionKey);
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
  private resetIdleTimer(connectionKey: string): void {
    this.clearIdleTimer(connectionKey);
    const timer = setTimeout(() => {
      this.closeTenantConnection(connectionKey).catch((err) =>
        console.error(
          `Failed to close idle connection [${connectionKey}]:`,
          err,
        ),
      );
    }, this.idleTimeoutMs);
    timer.unref?.(); // don't keep the process alive just for this
    this.idleTimers.set(connectionKey, timer);
  }

  private clearIdleTimer(connectionKey: string): void {
    const existing = this.idleTimers.get(connectionKey);
    if (existing) {
      clearTimeout(existing);
      this.idleTimers.delete(connectionKey);
    }
  }
}

export const connectionManager = new ConnectionManager();
