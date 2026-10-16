import type { IEventHandler } from "./IEventHandler.js";

const HANDLER_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** Which handlers subscribe to which event types. Built once at startup. */
export class EventHandlerRegistry {
  private readonly byName = new Map<string, IEventHandler>();
  private readonly byEventType = new Map<string, IEventHandler[]>();

  constructor(handlers: readonly IEventHandler[]) {
    for (const handler of handlers) {
      if (!HANDLER_NAME.test(handler.name)) {
        throw new Error(`Invalid event handler name: ${handler.name}`);
      }
      if (this.byName.has(handler.name)) {
        throw new Error(`Duplicate event handler name: ${handler.name}`);
      }
      this.byName.set(handler.name, handler);
      for (const eventType of new Set(handler.eventTypes)) {
        const list = this.byEventType.get(eventType) ?? [];
        list.push(handler);
        this.byEventType.set(eventType, list);
      }
    }
  }

  handlersFor(eventType: string): readonly IEventHandler[] {
    return this.byEventType.get(eventType) ?? [];
  }

  byHandlerName(name: string): IEventHandler | undefined {
    return this.byName.get(name);
  }
}
