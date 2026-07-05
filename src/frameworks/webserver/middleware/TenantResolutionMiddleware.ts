import { NextFunction, Request, Response } from "express";
import { connectionManager } from "../../database/mongodb/connection-manager/ConnectionManager";
import { createTenantSystemModel } from "../../database/mongodb/system/TenantSystemModel";
import { createTenantModels } from "../../database/mongodb/tenant/TenantModelFactory";
import {
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
} from "../../../error_handler";
import { HttpStatusCode } from "../../../utils/constants";

export const tenantResolutionMiddleware =
  () => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const host = req.headers.host || req.hostname || "";
      const requestId =
        req.headers["x-request-id"]?.toString() || `${Date.now()}`;

      if (req.path.startsWith("/admin/tenants")) {
        const systemConnection = await connectionManager.getSystemConnection();
        (req as any).context = {
          tenant: null,
          connection: systemConnection,
          models: createTenantModels(systemConnection),
          requestId,
        };
        return next();
      }

      const isLocalHost =
        host.includes("localhost") || host.includes("127.0.0.1");
      if (isLocalHost) {
        const systemConnection = await connectionManager.getSystemConnection();
        (req as any).context = {
          tenant: null,
          connection: systemConnection,
          models: createTenantModels(systemConnection),
          requestId,
        };
        return next();
      }

      const hostname = host.split(":")[0];
      const subdomain = hostname.split(".")[0];
      if (!subdomain || subdomain === "www") {
        return next(new BadRequestError("Tenant host is required"));
      }

      const systemConnection = await connectionManager.getSystemConnection();
      const TenantSystemModel = createTenantSystemModel(systemConnection);
      const tenant = await TenantSystemModel.findOne({
        slug: subdomain,
        isDeleted: { $ne: true },
      }).lean();
      if (!tenant) {
        return next(new NotFoundError(`Tenant ${subdomain} was not found`));
      }

      if (tenant.status !== "active") {
        return next(new UnauthorizedError(`Tenant is ${tenant.status}`));
      }

      if (tenant.subscriptionStatus !== "active") {
        return next(new UnauthorizedError("Subscription is not active"));
      }

      if (
        tenant.subscriptionExpiresAt &&
        new Date(tenant.subscriptionExpiresAt) < new Date()
      ) {
        return next(new UnauthorizedError("Subscription has expired"));
      }

      const tenantConnection = await connectionManager.getTenantConnection(
        tenant as any,
      );
      (req as any).context = {
        tenant,
        connection: tenantConnection,
        models: createTenantModels(tenantConnection),
        requestId,
      };

      next();
    } catch (error) {
      next(new BadRequestError((error as Error).message));
    }
  };
