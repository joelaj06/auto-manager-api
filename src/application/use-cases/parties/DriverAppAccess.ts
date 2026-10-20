import { createHash, randomBytes } from "node:crypto";
import { TenantUser } from "../../../domain/entities/TenantUser.js";
import type { ITenantUserRepository } from "../../../domain/repositories/ITenantUserRepository.js";
import type { DriverStatus } from "../../../domain/parties/Driver.js";
import type { Principal } from "../../authorization/Principal.js";
import { UserExistsError } from "../../errors/IdentityErrors.js";
import { DriverAppAccessError } from "../../errors/PartyErrors.js";
import type { NotificationService } from "../../notifications/NotificationService.js";
import type { IClock } from "../../ports/IClock.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IQrCodeRenderer } from "../../ports/IConnectLinkSigner.js";
import type { IDriverAppLinks } from "../../ports/IDriverAppLinks.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type {
  INotificationDeliveries,
  INotificationSettingsStore,
} from "../../ports/INotifications.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IPermissionCache } from "../../ports/IPermissionCache.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { ITenantRoles } from "../../ports/ITenantRoles.js";
import type { ITenantSessions } from "../../ports/ITenantSessions.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { IUserDirectory } from "../../ports/IUserDirectory.js";
import type { IUserInvitations } from "../../ports/IUserInvitations.js";
import type { IUserMemberships } from "../../ports/IUserMemberships.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { DriverAdministration, IDriverStatusListener } from "./DriverAdministration.js";

/** The system role a driver's login holds (docs/28 §6). */
export const DRIVER_ROLE = "driver";

export type DriverAppAccessView = Readonly<{
  driverId: string;
  userId: string | null;
  /** none: never given; invited: link sent, not used yet; active; disabled: taken away. */
  status: "none" | "invited" | "active" | "disabled";
  lastLoginAt: Date | null;
}>;

export type DriverInvitation = Readonly<{
  /** Opens the app on the driver's phone (signed connect link). */
  appUrl: string | null;
  /** The same invitation on the web. */
  webUrl: string;
  /** QR of the app link, to scan from the screen in person. */
  qrSvg: string | null;
  expiresAt: Date;
  /** Where the link was also sent. */
  sentBy: readonly ("sms" | "email")[];
}>;

/**
 * Driver app logins (docs/09 §4, docs/23): staff give an active driver a login — a user with the
 * Driver role, linked to the driver, in the driver's branch — and an invitation the driver opens
 * on their phone (QR on screen, SMS through the business's provider, or email) to set a password.
 * Staff can take it away again; terminating a driver takes it away automatically.
 */
export class DriverAppAccess implements IDriverStatusListener {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      tenantContext: ITenantContext;
      drivers: DriverAdministration;
      links: IDriverAppLinks;
      users: ITenantUserRepository;
      memberships: IUserMemberships;
      roles: ITenantRoles;
      invitations: IUserInvitations;
      sessions: ITenantSessions;
      directory: IUserDirectory;
      permissionCache: IPermissionCache;
      organisation: IOrganisationSettings;
      notifications: NotificationService;
      deliveries: INotificationDeliveries;
      notificationSettings: INotificationSettingsStore;
      qr: IQrCodeRenderer;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
      settings: Readonly<{
        webAppUrl: string;
        invitationTtlMs: number;
        appInvitationLink?: (tenantSlug: string, token: string, expiresAt: Date) => string;
      }>;
    }>,
  ) {}

  async status(actor: Principal, driverId: string): Promise<DriverAppAccessView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      await deps.drivers.reach(actor, driverId, "drivers.app_access.manage");
      return this.view(driverId);
    });
  }

  /**
   * Gives the driver a login, or a fresh invitation when the last one was not used. A login that
   * was taken away comes back as it was (same password).
   */
  async grant(
    actor: Principal,
    driverId: string,
    tenantSlug: string,
  ): Promise<DriverAppAccessView & Readonly<{ invitation: DriverInvitation | null }>> {
    const { deps } = this;
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(deps.clock.now().getTime() + deps.settings.invitationTtlMs);
    const outcome = await deps.unitOfWork.run(async () => {
      const driver = (
        await deps.drivers.reach(actor, driverId, "drivers.app_access.manage", true)
      ).snapshot();
      if (driver.status !== "active")
        throw new DriverAppAccessError("Only an active driver can get the driver app");
      const linkedId = await deps.links.userOf(driverId);
      let user = linkedId === null ? null : await deps.users.lockById(linkedId);
      if (user?.status === "active")
        throw new DriverAppAccessError("This driver already uses the app");
      if (user?.status === "disabled") {
        user.enable();
        await deps.users.save(user);
      }
      if (user === null) {
        if (
          (await deps.users.findByPhone(driver.phone)) !== null ||
          (driver.email !== null && (await deps.users.findByEmail(driver.email)) !== null)
        )
          throw new UserExistsError();
        const role = (await deps.roles.list()).find((r) => r.systemKey === DRIVER_ROLE);
        if (role === undefined) throw new DriverAppAccessError("The Driver role is not set up yet");
        user = TenantUser.invite({
          id: deps.ids.next(),
          name: `${driver.firstName} ${driver.lastName}`,
          email: driver.email,
          phone: driver.phone,
        });
        await deps.users.save(user, actor.userId);
        await deps.memberships.setBranches(user.id, [driver.branchId]);
        await deps.memberships.setAssignments(
          user.id,
          [{ roleId: role.id, branchId: null }],
          actor.userId,
        );
        await deps.links.link(driverId, user.id);
      }
      const invite = user.status === "invited";
      const sentBy: ("sms" | "email")[] = [];
      if (invite) {
        await deps.invitations.create({
          userId: user.id,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          expiresAt,
        });
        const settings = await deps.notificationSettings.get();
        const appUrl = deps.settings.appInvitationLink?.(tenantSlug, token, expiresAt) ?? null;
        if (settings.sms !== null) {
          const { name } = await deps.organisation.get();
          await deps.deliveries.queue({
            channel: "sms",
            rule: "driver_invitation",
            recipientType: "driver",
            recipientId: driverId,
            address: driver.phone,
            title: null,
            body: `${name}: your driver app account is ready. Open ${appUrl ?? this.webUrl(tenantSlug, token)} to set your password (valid ${this.validity()}).`,
            data: {},
            dedupeKey: `driver_invitation:${createHash("sha256").update(token).digest("hex")}`,
            sendAfter: deps.clock.now(),
            sensitive: true,
          });
          sentBy.push("sms");
        }
        if (driver.email !== null) sentBy.push("email");
      }
      await recordUserAction(deps, actor.userId, {
        action: "driver.app_access_granted",
        entityType: "driver",
        entityId: driverId,
        after: { userId: user.id, status: user.status },
      });
      return { driver, user, invite, sentBy };
    });
    deps.permissionCache.forgetTenant(deps.tenantContext.currentTenantId().value);
    if (outcome.user.status === "active") await this.publish(outcome.user, "active");

    let invitation: DriverInvitation | null = null;
    if (outcome.invite) {
      const appUrl = deps.settings.appInvitationLink?.(tenantSlug, token, expiresAt) ?? null;
      if (outcome.driver.email !== null) {
        const { name } = await deps.unitOfWork.run(() => deps.organisation.get());
        await deps.notifications.sendEmail({
          to: outcome.driver.email,
          template: "tenant.user_invitation",
          data: {
            name: outcome.user.name,
            businessName: name,
            invitedBy: null,
            acceptUrl: this.webUrl(tenantSlug, token),
            appUrl,
            expiresInHours: Math.round(deps.settings.invitationTtlMs / 3_600_000),
          },
          idempotencyKey: `driver-invitation:${createHash("sha256").update(token).digest("hex")}`,
          tenantId: deps.tenantContext.currentTenantId().value,
        });
      }
      invitation = {
        appUrl,
        webUrl: this.webUrl(tenantSlug, token),
        qrSvg: appUrl === null ? null : await deps.qr.svg(appUrl),
        expiresAt,
        sentBy: outcome.sentBy,
      };
    }
    const view = await deps.unitOfWork.run(() => this.view(driverId));
    return { ...view, invitation };
  }

  /** Takes the login away: it is disabled and every session ends. */
  async revoke(actor: Principal, driverId: string): Promise<DriverAppAccessView> {
    const { deps } = this;
    const user = await deps.unitOfWork.run(async () => {
      await deps.drivers.reach(actor, driverId, "drivers.app_access.manage", true);
      const disabled = await this.disable(driverId);
      if (disabled === null) throw new DriverAppAccessError("This driver has no app login");
      await recordUserAction(deps, actor.userId, {
        action: "driver.app_access_revoked",
        entityType: "driver",
        entityId: driverId,
        after: { userId: disabled.id },
      });
      return disabled;
    });
    deps.permissionCache.forgetTenant(deps.tenantContext.currentTenantId().value);
    await this.publish(user, "disabled");
    return deps.unitOfWork.run(() => this.view(driverId));
  }

  /** A terminated driver loses the app (inside the termination's unit of work). */
  async driverStatusChanged(driverId: string, status: DriverStatus): Promise<void> {
    if (status !== "terminated") return;
    const user = await this.disable(driverId);
    if (user === null) return;
    this.deps.permissionCache.forgetTenant(this.deps.tenantContext.currentTenantId().value);
    await this.publish(user, "disabled");
  }

  private async disable(driverId: string): Promise<TenantUser | null> {
    const { deps } = this;
    const userId = await deps.links.userOf(driverId);
    const user = userId === null ? null : await deps.users.lockById(userId);
    if (user === null || user.status === "disabled") return null;
    user.disable();
    await deps.users.save(user);
    await deps.sessions.revokeForUser(user.id, "user_disabled", deps.clock.now());
    return user;
  }

  /** Multi-business sign-in in the app finds (or stops finding) this business for the driver. */
  private async publish(user: TenantUser, status: "active" | "disabled"): Promise<void> {
    await this.deps.directory.upsert({
      tenantId: this.deps.tenantContext.currentTenantId().value,
      tenantUserId: user.id,
      email: user.email,
      phone: user.phone,
      status,
    });
  }

  private async view(driverId: string): Promise<DriverAppAccessView> {
    const userId = await this.deps.links.userOf(driverId);
    const user = userId === null ? null : await this.deps.users.findById(userId);
    return {
      driverId,
      userId,
      status: user === null ? "none" : user.status,
      lastLoginAt: user?.snapshot().lastLoginAt ?? null,
    };
  }

  private webUrl(tenantSlug: string, token: string): string {
    return `${this.deps.settings.webAppUrl.replace(/\/$/, "")}/${tenantSlug}/accept-invitation#token=${token}`;
  }

  private validity(): string {
    const hours = Math.round(this.deps.settings.invitationTtlMs / 3_600_000);
    return hours % 24 === 0 ? `${hours / 24} days` : `${hours} hours`;
  }
}
