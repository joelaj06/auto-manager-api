import type { Principal } from "../../authorization/Principal.js";
import type { IClock } from "../../ports/IClock.js";
import type {
  InboxItem,
  INotificationInbox,
  IPushDevices,
  PushPlatform,
} from "../../ports/INotifications.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { PageCursor } from "../../services/PageCursor.js";

export type InboxPage = Readonly<{
  items: readonly InboxItem[];
  unread: number;
  nextCursor: string | null;
}>;

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
    query: Readonly<{ unreadOnly?: boolean; cursor?: string; limit: number }>,
  ): Promise<InboxPage> {
    const { deps } = this;
    const after = query.cursor === undefined ? undefined : PageCursor.parse(query.cursor, 1).values;
    return deps.unitOfWork.run(async () => {
      const rows = await deps.inbox.list(actor.userId, {
        unreadOnly: query.unreadOnly ?? false,
        limit: query.limit + 1,
        ...(after === undefined ? {} : { afterId: String(after[0]) }),
      });
      const page = PageCursor.paginate(rows, query.limit, (r) => [r.id]);
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
