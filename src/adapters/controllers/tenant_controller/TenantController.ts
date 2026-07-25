import { inject, injectable } from "inversify";
import { NextFunction, Request, Response } from "express";
import { ITenantInteractor } from "../../../application/interactors";
import { HttpStatusCode, INTERFACE_TYPE } from "../../../utils/constants";
import { BadRequestError } from "../../../error_handler";
import { RequestQuery } from "../../../entities";

@injectable()
export class TenantController {
  private tenantInteractor: ITenantInteractor;

  constructor(
    @inject(INTERFACE_TYPE.TenantInteractorImpl)
    tenantInteractor: ITenantInteractor,
  ) {
    this.tenantInteractor = tenantInteractor;
  }

  async createTenant(req: Request, res: Response, next: NextFunction) {
    try {
      const tenant = await this.tenantInteractor.createTenant(req.body);
      return res.status(HttpStatusCode.CREATED).json(tenant);
    } catch (error) {
      next(error);
    }
  }

  async getAllTenants(req: Request, res: Response, next: NextFunction) {
    try {
      const query: RequestQuery = {
        search: req.query.search?.toString(),
        pageIndex: req.query.pageIndex
          ? Number(req.query.pageIndex)
          : undefined,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : undefined,
      };
      const response = await this.tenantInteractor.getAllTenants(query);
      res.set(
        "x-pagination",
        JSON.stringify({
          totalPages: response.totalPages,
          pageCount: response.pageCount,
          totalCount: response.totalCount,
        }),
      );
      return res.status(HttpStatusCode.OK).json(response.data);
    } catch (error) {
      next(error);
    }
  }

  async getTenant(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      if (!id) throw new BadRequestError("Tenant id is required");
      const tenant = await this.tenantInteractor.getTenant(id);
      return res.status(HttpStatusCode.OK).json(tenant);
    } catch (error) {
      next(error);
    }
  }

  async updateTenant(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const tenant = await this.tenantInteractor.updateTenant(id, req.body);
      return res.status(HttpStatusCode.OK).json(tenant);
    } catch (error) {
      next(error);
    }
  }

  async deleteTenant(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      await this.tenantInteractor.deleteTenant(id);
      return res.status(HttpStatusCode.NO_CONTENT).send();
    } catch (error) {
      next(error);
    }
  }

  async activateTenant(req: Request, res: Response, next: NextFunction) {
    try {
      const tenant = await this.tenantInteractor.activateTenant(req.params.id);
      return res.status(HttpStatusCode.OK).json(tenant);
    } catch (error) {
      next(error);
    }
  }

  async deactivateTenant(req: Request, res: Response, next: NextFunction) {
    try {
      const tenant = await this.tenantInteractor.deactivateTenant(
        req.params.id,
      );
      return res.status(HttpStatusCode.OK).json(tenant);
    } catch (error) {
      next(error);
    }
  }

  async suspendTenant(req: Request, res: Response, next: NextFunction) {
    try {
      const tenant = await this.tenantInteractor.suspendTenant(req.params.id);
      return res.status(HttpStatusCode.OK).json(tenant);
    } catch (error) {
      next(error);
    }
  }

  async renewSubscription(req: Request, res: Response, next: NextFunction) {
    try {
      const { subscriptionExpiresAt } = req.body;
      const tenant = await this.tenantInteractor.renewSubscription(
        req.params.id,
        new Date(subscriptionExpiresAt),
      );
      return res.status(HttpStatusCode.OK).json(tenant);
    } catch (error) {
      next(error);
    }
  }
}
