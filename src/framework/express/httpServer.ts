import type { Server } from "node:http";
import type { Express } from "express";

/** Starts listening; resolves once the port is bound (rejects if it cannot be). */
export function startHttpServer(app: Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port);
    server.once("listening", () => resolve(server));
    server.once("error", reject);
    // Keep-alive slightly above typical load-balancer idle timeouts to avoid 502s.
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    server.requestTimeout = 30_000;
  });
}

/** Stops accepting connections, closes idle keep-alive sockets, waits for in-flight requests. */
export function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}
