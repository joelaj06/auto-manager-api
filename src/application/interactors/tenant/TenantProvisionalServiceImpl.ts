import { inject, injectable } from "inversify";
import { ITenant } from "../../../entities";
import {
  INTERFACE_TYPE,
  Permissions,
  TenantAdminPermissions,
} from "../../../utils/constants";

import {
  ITenantRepository,
  IUserRepository,
  IRoleRepository,
} from "../../../frameworks";
import { ICompanyInteractor } from "../company";
import { IAuthService } from "../../../frameworks/services/auth/IAuthService";
import { connectionManager } from "../../../frameworks/database/mongodb/connection-manager/ConnectionManager";
import { createTenantModels } from "../../../frameworks/database/mongodb/tenant/TenantModelFactory";
import { createSystemModels } from "../../../frameworks/database/mongodb/system";
import { tenantContextStorage } from "../../../frameworks/database/tenant-context/TenantContextStorage";
import { BadRequestError } from "../../../error_handler";
import config from "../../../config/config";
import {
  AdminUserInput,
  ITenantProvisioningService,
  ProvisioningResult,
} from "./ITenantProvisioningService";

const TRIAL_PERIOD_DAYS = 14; // adjust default trial length here

@injectable()
export class TenantProvisioningServiceImpl implements ITenantProvisioningService {
  constructor(
    @inject(INTERFACE_TYPE.TenantRepositoryImpl)
    private tenantRepository: ITenantRepository,
    @inject(INTERFACE_TYPE.UserRepositoryImpl)
    private userRepository: IUserRepository,
    @inject(INTERFACE_TYPE.RoleRepositoryImpl)
    private roleRepository: IRoleRepository,
    @inject(INTERFACE_TYPE.CompanyInteractorImpl)
    private companyInteractor: ICompanyInteractor,
    @inject(INTERFACE_TYPE.AuthServiceImpl) private authService: IAuthService,
  ) {}

  async provision(
    tenant: ITenant,
    adminUser: AdminUserInput,
  ): Promise<ProvisioningResult> {
    if (!adminUser?.email || !adminUser?.password) {
      throw new BadRequestError(
        "Admin user email and password are required to provision a tenant",
      );
    }

    try {
      // Step 1: open (and thereby create) the tenant's physical database
      const tenantConnection =
        await connectionManager.getTenantConnection(tenant);
      const tenantModels = createTenantModels(tenantConnection);

      // Steps 2-6 all run inside the new tenant's context, so existing
      // interactors/repositories work completely unmodified.
      const { company, adminUserRecord, role } = await tenantContextStorage.run(
        {
          tenant,
          connection: tenantConnection,
          models: tenantModels,
          requestId: `provision-${tenant.slug}-${Date.now()}`,
        },
        async () => {
          // Step 2: seed Permission documents (registry only — checkPermission
          // reads role.permissions strings directly, this is for admin UI listing)

          for (const key of TenantAdminPermissions) {
            await tenantModels.Permission.updateOne(
              { name: key },
              { $setOnInsert: { name: key } },
              { upsert: true },
            );
          }

          // Step 3: create the admin User first, with no role/company yet —
          // breaks the User <-> Company <-> Role circular dependency
          const hashedPassword = await this.authService.encriptPassword(
            adminUser.password,
          );
          const createdUser = await this.userRepository.addUser({
            firstName: adminUser.firstName,
            lastName: adminUser.lastName,
            email: adminUser.email,
            phone: adminUser.phone,
            password: hashedPassword,
            isVerified: true, // system-provisioned, skip OTP verification
            isActive: true,
            status: "active",
          } as any);

          // Step 4: create the Company, owned by that user.
          // Reuses your existing addCompany flow (uniqueness check, logo handling,
          // and it back-fills user.company on the owner automatically).
          const createdCompany = await this.companyInteractor.addCompany({
            name: tenant.name,
            email: adminUser.email,
            phone: adminUser.phone || "",
            ownerId: createdUser._id,
            createdBy: createdUser._id,
          } as any);

          // Step 5: create the "Admin" role, now that a company id exists
          const createdRole = await this.roleRepository.addRole({
            name: "Admin",
            description: "Full access administrator role",
            companyId: createdCompany._id,
            permissions: TenantAdminPermissions,
          } as any);

          // Step 6: patch the user with its role (company already set by addCompany)
          await this.userRepository.updateUser(createdUser._id!, {
            _id: createdUser._id,
            role: createdRole?._id,
          } as any);

          return {
            company: createdCompany,
            adminUserRecord: createdUser,
            role: createdRole,
          };
        },
      );

      // Steps 7-9 run against the System DB — outside the tenant context.
      const systemConnection = await connectionManager.getSystemConnection();
      const systemModels = createSystemModels(systemConnection);

      const currentPeriodEnd = new Date(
        Date.now() + TRIAL_PERIOD_DAYS * 24 * 60 * 60 * 1000,
      );

      await systemModels.Subscription.create({
        tenantId: tenant._id,
        plan: "basic",
        status: "trialing",
        currentPeriodEnd,
      });

      await systemModels.AuditLog.create({
        tenantId: tenant._id,
        action: "tenant.provisioned",
        actorId: adminUserRecord._id,
        metadata: {
          companyId: company._id,
          roleId: role?._id,
          slug: tenant.slug,
        },
      });

      // Step 9: activate the tenant now that provisioning succeeded
      const activatedTenant = await this.tenantRepository.updateTenant(
        tenant._id!,
        {
          status: "active",
          subscriptionStatus: "active",
          subscriptionExpiresAt: currentPeriodEnd,
        } as any,
      );

      const tenantUrl = `https://${tenant.subdomain}.${config.appBaseDomain}`;

      return { tenant: activatedTenant, tenantUrl };
    } catch (error) {
      // Provisioning failed partway through — mark the tenant record so it's
      // visible in the admin list as broken rather than silently "inactive".
      // NOTE: this does not roll back partially-created tenant-DB documents
      // (User/Company/Role) or the physical database — see note below.
      await this.tenantRepository
        .updateTenant(tenant._id!, {
          status: "inactive",
        } as any)
        .catch(() => {}); // best-effort, don't mask the original error
      throw error;
    }
  }
}
