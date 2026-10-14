import { AsyncLocalStorage } from "node:async_hooks";
import type {
  IRequestContext,
  RequestContextData,
} from "../../application/ports/IRequestContext.js";

/** IRequestContext backed by AsyncLocalStorage: request facts follow the async call chain. */
export class AsyncLocalRequestContext implements IRequestContext {
  private readonly storage = new AsyncLocalStorage<RequestContextData>();

  run<T>(data: RequestContextData, fn: () => T): T {
    return this.storage.run(data, fn);
  }

  current(): RequestContextData | undefined {
    return this.storage.getStore();
  }
}
