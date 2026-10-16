import { randomUUID } from "node:crypto";
import type { Container } from "inversify";
import type { IClock } from "../../application/ports/IClock.js";
import type { IPlatformRoles } from "../../application/ports/IPlatformRoles.js";
import type { StaffAdministration } from "../../application/use-cases/platform/StaffAdministration.js";
import type { StaffSignIn } from "../../application/use-cases/platform/StaffSignIn.js";
import { TYPES } from "../../framework/dependency-injection/types.js";
import { TotpService } from "../../infrastructure/security/TotpService.js";

export type TestStaff = Readonly<{
  id: string;
  email: string;
  password: string;
  totpSecret: string;
  accessToken: string;
  refreshToken: string;
}>;

export const TEST_STAFF_PASSWORD = "correct horse battery staple";

/**
 * Active console staff for integration tests, created through the real invitation and TOTP
 * enrolment use cases (as `yarn platform:invite-admin` + the sign-in flow would).
 */
export class StaffFixtures {
  private readonly totp = new TotpService();

  constructor(private readonly container: Container) {}

  async create(systemRoles: readonly string[] = ["super_admin"]): Promise<TestStaff> {
    const roles = this.container.get<IPlatformRoles>(TYPES.PlatformRoles);
    const roleIds: string[] = [];
    for (const key of systemRoles) {
      const role = await roles.findBySystemKey(key);
      if (role === null) throw new Error(`Unknown system role ${key}`);
      roleIds.push(role.id);
    }
    const email = `staff-${randomUUID().slice(0, 8)}@example.com`;
    const invited = await this.container
      .get<StaffAdministration>(TYPES.StaffAdministration)
      .invite({ email, name: "Test Staff", roleIds, actor: null });
    return this.activate(invited.invitationToken!, invited.userId, email);
  }

  /**
   * Accepts an invitation (e.g. a partner user's, taken from the queued email), enrols TOTP and
   * signs in.
   */
  async activate(invitationToken: string, userId: string, email: string): Promise<TestStaff> {
    const signIn = this.container.get<StaffSignIn>(TYPES.StaffSignIn);
    const step = await signIn.acceptInvitation(invitationToken, TEST_STAFF_PASSWORD);
    const { secret } = await signIn.beginTotpEnrolment(step.challengeToken);
    const now = this.container.get<IClock>(TYPES.Clock).now();
    const tokens = await signIn.confirmTotpEnrolment(
      step.challengeToken,
      this.totp.codeAt(secret, now),
      "vitest",
    );
    return {
      id: userId,
      email,
      password: TEST_STAFF_PASSWORD,
      totpSecret: secret,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }
}
