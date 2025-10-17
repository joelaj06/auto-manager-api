import { inject, injectable } from "inversify";
import {
  TWorkAndPayFrequency,
  IWorkAndPayAgreement,
  IPaymentRecord,
} from "../../../entities";
import { IWorkAndPayInteractor } from "./IWorkAndPayInteractor";
import {
  IVehicleRepository,
  IWorkAndPayRepository,
} from "../../../frameworks/database/mongodb/repositories";
import { INTERFACE_TYPE } from "../../../utils/constants/bindings";
import { BadRequestError, NotFoundError } from "../../../error_handler";

@injectable()
export class WorkAndPayInteractorImpl implements IWorkAndPayInteractor {
  constructor(
    @inject(INTERFACE_TYPE.WorkAndPayRepositoryImpl)
    private readonly workAndPayRepo: IWorkAndPayRepository,
    @inject(INTERFACE_TYPE.VehicleRepositoryImpl)
    private readonly vehicleRepo: IVehicleRepository
  ) {
    this.workAndPayRepo = workAndPayRepo;
    this.vehicleRepo = vehicleRepo;
  }
  async getPaymentsByAgreementId(
    agreementId: string
  ): Promise<IPaymentRecord[]> {
    const agreement = this.workAndPayRepo.getAgreementById(agreementId);
    if (!agreement) {
      throw new NotFoundError("Agreement not found.");
    }
    return await this.workAndPayRepo.getPaymentsByAgreementId(agreementId);
  }
  calculateInstallment(
    originalPrice: number,
    multiplier: number,
    durationYears: number,
    finalPrice: number,
    frequency: TWorkAndPayFrequency
  ): { totalSalePrice: number; installmentAmount: number } {
    const totalSalePrice = finalPrice || originalPrice * multiplier;
    const totalPeriods =
      frequency === "weekly" ? durationYears * 52 : durationYears * 12;

    // Calculate installment amount and
    // round up to the nearest two decimal places for currency precision.
    const installmentAmount =
      Math.ceil((totalSalePrice / totalPeriods) * 100) / 100;

    return { totalSalePrice, installmentAmount };
  }
  async initiateAgreement(data: {
    ownerId: string;
    driverId: string;
    vehicleId: string;
    originalPrice: number;
    multiplier: number;
    durationYears: number;
    frequency: TWorkAndPayFrequency;
    finalPrice: number;
  }): Promise<IWorkAndPayAgreement> {
    if (!data.ownerId || !data.driverId || !data.vehicleId) {
      throw new Error("Missing essential IDs for agreement initiation.");
    }

    const { totalSalePrice, installmentAmount } = this.calculateInstallment(
      data.originalPrice,
      data.multiplier,
      data.durationYears,
      data.finalPrice,
      data.frequency
    );

    // Prepare the initial agreement entity
    const newAgreement: Omit<IWorkAndPayAgreement, "id" | "agreementId"> = {
      ownerId: data.ownerId,
      driverId: data.driverId,
      vehicleId: data.vehicleId,
      originalVehiclePrice: data.originalPrice,
      totalSalePrice: totalSalePrice,
      installmentAmount: installmentAmount,
      paymentFrequency: data.frequency,
      durationYears: data.durationYears,
      createdBy: data.ownerId,
      amountPaid: 0,
      balanceDue: totalSalePrice,
      installmentsPaid: 0,
      installmentsRemaining:
        data.frequency === "weekly"
          ? data.durationYears * 52
          : data.durationYears * 12,

      status: "Active",
      startDate: new Date().toISOString(),
      completionDate: null,
    };

    const agreement = await this.workAndPayRepo.createAgreement(newAgreement);
    return agreement;
  }

  async processPayment(
    agreementId: string,
    amount: number,
    method: string,
    recordedByUserId: string
  ): Promise<IWorkAndPayAgreement> {
    if (amount <= 0) {
      throw new Error("Payment amount must be positive.");
    }

    const agreement = await this.workAndPayRepo.getAgreementById(agreementId);
    if (!agreement) {
      throw new NotFoundError("Agreement not found.");
    }

    if (agreement.status === "Completed") {
      throw new BadRequestError("Agreement is already completed.");
    }

    if (amount > agreement.balanceDue) {
      throw new BadRequestError("Payment amount exceeds balance due.");
    }

    if (amount < agreement.installmentAmount) {
      throw new BadRequestError(
        `Payment amount should not be less than the installment amount. (${agreement.installmentAmount})`
      );
    }

    const payment: Omit<IPaymentRecord, "id" | "agreementId" | "paymentId"> = {
      amount: amount,
      paymentDate: new Date().toISOString(),
      recordedBy: recordedByUserId,
      method: method,
      workAndPayAgreementId: agreementId,
    };

    const { updatedAgreement } = await this.workAndPayRepo.recordPayment(
      agreementId,
      payment
    );

    // Business Rule: Check for completion
    if (
      updatedAgreement.balanceDue <= 0.01 &&
      updatedAgreement.status !== "Completed"
    ) {
      // update vehicle ownership
      await this.vehicleRepo.updateVehicle(updatedAgreement.vehicleId, {
        ownerId: updatedAgreement.driverId,
        status: "Sold",
      });
    }

    return updatedAgreement;
  }
  getAgreementDetails(
    agreementId: string
  ): Promise<IWorkAndPayAgreement | null> {
    return this.workAndPayRepo.getAgreementById(agreementId);
  }
}
