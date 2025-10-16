import { NextFunction, Request, Response } from "express";
import { inject, injectable } from "inversify";
import { INTERFACE_TYPE } from "../../../utils/constants/bindings";
import { IWorkAndPayInteractor } from "../../../application/interactors/workandpay";
import { ControllerUserRequest } from "../auth_controller/IController";
import { HttpStatusCode } from "../../../utils/constants/enums";
import { next } from "inversify-express-utils";

// The Controller acts as the entry point for HTTP requests.
@injectable()
export class WorkAndPayController {
  constructor(
    @inject(INTERFACE_TYPE.WorkAndPayInteractorImpl)
    private readonly interactor: IWorkAndPayInteractor
  ) {
    this.interactor = interactor;
  }

  /**
   * @route POST /api/work-pay/agreement
   * @description Initiates a new Work and Pay agreement.
   */
  public async initiateAgreement(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    // Get the user ID from the authenticated request (assumed to be the owner)
    const ownerId = req.user?._id;

    const {
      driverId,
      vehicleId,
      originalPrice,
      multiplier, // Should be 2 (or dynamic based on policy)
      durationYears,
      frequency, // 'weekly' or 'monthly'
    } = req.body;

    try {
      // 1. Calculate the values first (optional, but good for validation)
      const calculation = this.interactor.calculateInstallment(
        originalPrice,
        multiplier,
        durationYears,
        frequency
      );

      // 2. Create the agreement
      const agreement = await this.interactor.initiateAgreement({
        ownerId: ownerId!,
        driverId,
        vehicleId,
        originalPrice,
        multiplier,
        durationYears,
        frequency,
      });

      res.status(HttpStatusCode.CREATED).json({
        message: "Work and Pay Agreement initiated successfully.",
        data: agreement,
        calculationPreview: calculation, // calculation for frontend confirmation
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   *@route POST /api/work-pay/payment
   *@description Records an installment payment.
   */
  public async recordPayment(
    req: ControllerUserRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    // Get the user ID who is recording the payment (could be the owner/admin)
    const recordedByUserId = req.user?._id;

    const { agreementId, amount, method } = req.body;

    try {
      const updatedAgreement = await this.interactor.processPayment(
        agreementId,
        amount,
        method,
        recordedByUserId!
      );

      res.status(HttpStatusCode.CREATED).json({
        message: "Payment recorded successfully.",
        data: updatedAgreement,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * @route GET /api/work-pay/agreement/:id
   * @description Retrieves agreement details.
   */
  public async getAgreement(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const agreementId = req.params.id;

    try {
      const agreement = await this.interactor.getAgreementDetails(agreementId);

      if (!agreement) {
        res
          .status(HttpStatusCode.NOT_FOUND)
          .json({ error: "Agreement not found." });
        return;
      }

      res.status(HttpStatusCode.OK).json({ data: agreement });
    } catch (error) {
      next(error);
    }
  }
}
