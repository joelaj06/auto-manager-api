import type { ApiKeyActor, SupportActor } from "../authorization/Principal.js";

/** Facts about the request (or job) being handled, available anywhere in its async call chain. */
export type RequestContextData = Readonly<{
  requestId: string;
  method?: string;
  path?: string;
  ip?: string;
  /** Platform staff acting in a tenant through support access (docs/27 §3.8). */
  support?: SupportActor;
  /** The API key the request came with (named in the tenant's audit log). */
  apiKey?: ApiKeyActor;
}>;

export interface IRequestContext {
  run<T>(data: RequestContextData, fn: () => T): T;
  /** The current request's data, or undefined outside a request. */
  current(): RequestContextData | undefined;
}
