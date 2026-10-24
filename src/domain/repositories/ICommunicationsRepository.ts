export type AnnouncementAudience = Readonly<{
  statuses?: readonly string[];
  licenceTypes?: readonly string[];
  tenantIds?: readonly string[];
}>;

export type AnnouncementStatus = "draft" | "awaiting_approval" | "published" | "withdrawn";

export type Announcement = Readonly<{
  id: string;
  title: string;
  body: string;
  severity: "info" | "warning" | "critical";
  audience: AnnouncementAudience;
  email: boolean;
  startsAt: Date;
  endsAt: Date;
  status: AnnouncementStatus;
  approvalId: string | null;
  emailedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  publishedAt: Date | null;
}>;

export type MaintenanceWindow = Readonly<{
  id: string;
  title: string;
  message: string;
  startsAt: Date;
  endsAt: Date;
  readOnly: boolean;
  status: "scheduled" | "cancelled";
  createdBy: string;
  createdAt: Date;
  cancelledAt: Date | null;
}>;

/** Announcements and maintenance windows (platform database). */
export interface ICommunicationsRepository {
  saveAnnouncement(announcement: Announcement): Promise<void>;
  announcement(id: string, lock?: boolean): Promise<Announcement | null>;
  announcements(
    filter: Readonly<{ status?: AnnouncementStatus; limit: number }>,
  ): Promise<Announcement[]>;
  /** Published, live now, and addressed to this tenant (with whether this user read each). */
  liveFor(
    tenantId: string,
    userId: string,
    now: Date,
  ): Promise<(Announcement & Readonly<{ read: boolean }>)[]>;
  /** Tenants an audience reaches (not archived, not still provisioning). */
  audienceTenants(audience: AnnouncementAudience): Promise<string[]>;
  markRead(announcementId: string, tenantId: string, userId: string): Promise<void>;
  readStats(announcementId: string): Promise<Readonly<{ tenants: number; users: number }>>;
  markEmailed(announcementId: string, now: Date): Promise<void>;

  saveWindow(window: MaintenanceWindow): Promise<void>;
  window(id: string, lock?: boolean): Promise<MaintenanceWindow | null>;
  windows(filter: Readonly<{ from?: Date; limit: number }>): Promise<MaintenanceWindow[]>;
  /** Scheduled windows that are on now or start before `until`. */
  upcoming(now: Date, until: Date): Promise<MaintenanceWindow[]>;
}
