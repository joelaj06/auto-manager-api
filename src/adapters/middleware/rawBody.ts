import type { IncomingMessage } from "node:http";

/** A request whose raw JSON body was kept by the body parser (webhook signatures). */
export type RawBodyRequest = IncomingMessage & { rawBody?: Buffer };
