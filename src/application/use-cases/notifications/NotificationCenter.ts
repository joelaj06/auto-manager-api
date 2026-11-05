import { pageOf, pageWindow, type Page } from "../../dto/Page.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IClock } from "../../ports/IClock.js";
import type {
  InboxItem,
  INotificationInbox,
  IPushDevices,
  PushPlatform,
} from "../../ports/INotifications.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";

export type InboxPage = Page<InboxItem> & Readonly<{ unread: number }>;

/** A staff member's own notifications (the bell) and the app installations that get push. */
export class NotificationCenter {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      inbox: INotificationInbox;
      devices: IPushDevices;
      clock: IClock;
    }>,
  ) {}

  async list(
    actor: Principal,
    query: Readonly<{ unreadOnly?: boolean; page: number; pageSize: number }>,
  ): Promise<InboxPage> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const found = await deps.inbox.list(actor.userId, {
        unreadOnly: query.unreadOnly ?? false,
        ...pageWindow(query),
      });
      const page = pageOf(query, found);
      return { ...page, unread: await deps.inbox.unreadCount(actor.userId) };
    });
  }

  unreadCount(actor: Principal): Promise<number> {
    return this.deps.unitOfWork.run(() => this.deps.inbox.unreadCount(actor.userId));
  }

  /** Marks the given notifications read (all when `ids` is null); returns the unread left. */
  async markRead(actor: Principal, ids: readonly string[] | null): Promise<number> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      await deps.inbox.markRead(actor.userId, ids, deps.clock.now());
      return deps.inbox.unreadCount(actor.userId);
    });
  }

  registerDevice(actor: Principal, token: string, platform: PushPlatform): Promise<void> {
    const { deps } = this;
    return deps.unitOfWork.run(() =>
      deps.devices.register(actor.userId, token, platform, deps.clock.now()),
    );
  }

  removeDevice(actor: Principal, token: string): Promise<void> {
    return this.deps.unitOfWork.run(() => this.deps.devices.remove(actor.userId, token));
  }
}
