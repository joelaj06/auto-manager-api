/** Facts about the request (or job) being handled, available anywhere in its async call chain. */
export type RequestContextData = Readonly<{
  requestId: string;
  method?: string;
  path?: string;
  ip?: string;
}>;

export interface IRequestContext {
  run<T>(data: RequestContextData, fn: () => T): T;
  /** The current request's data, or undefined outside a request. */
  current(): RequestContextData | undefined;
}
