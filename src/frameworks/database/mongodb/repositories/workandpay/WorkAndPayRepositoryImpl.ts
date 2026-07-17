import { injectable } from "inversify";
import mongoose from "mongoose";
import { IWorkAndPayAgreement, IPaymentRecord } from "../../../../../entities";

import { PaymentRecordMapper } from "../../models/paymentRecord";
import { IWorkAndPayRepository } from "./IWorkAndPayRepository";
import { WorkAndPayAgreementMapper } from "../../models";
import { getTenantModels } from "../../../tenant-context/TenantContextStorage";

@injectable()
export class WorkAndPayRepositoryImpl implements IWorkAndPayRepository {
  //get agreement by driver id
  async getAgreementsByDriverId(
    driverId: string,
  ): Promise<IWorkAndPayAgreement> {
    try {
      const { WorkAndPayAgreement } = getTenantModels();
      if (!driverId) throw new Error("Driver id is required");
      const agreements = await WorkAndPayAgreement.find({ driver: driverId })
        .populate("vehicle")
        .populate("owner")
        .populate({
          path: "driver",
          select: "-vehicle",
        });
      if (!agreements || agreements.length === 0)
        throw new Error("No agreements found for this driver");

      return WorkAndPayAgreementMapper.toEntity(
        agreements[0],
      ) as unknown as IWorkAndPayAgreement; // Assuming one agreement per driver for simplicity
    } catch (error) {
      throw error;
    }
  }

  /**
   * Create a new Work & Pay agreement
   */
  async createAgreement(
    agreement: Omit<IWorkAndPayAgreement, "id">,
  ): Promise<IWorkAndPayAgreement> {
    try {
      const { WorkAndPayAgreement } = getTenantModels();
      if (!agreement) throw new Error("Agreement data is required");
      const agreementData = this.assignReferences(agreement);
      //check if agreement already exists for the same driver and vehicle
      const existingAgreement = await WorkAndPayAgreement.findOne({
        driver: agreementData.driver,
        vehicle: agreementData.vehicle,
      });
      if (existingAgreement) {
        throw new Error("Agreement already exists for this driver and vehicle");
      }
      // return agreementData as IWorkAndPayAgreement;
      const newAgreement = new WorkAndPayAgreement(agreementData);
      await newAgreement.save();
      if (!newAgreement) {
        throw new Error("Failed to create agreement");
      }
      const record = await WorkAndPayAgreement.findById(newAgreement._id)
        .populate("vehicle")
        .populate("owner")
        .populate("driver");
      return WorkAndPayAgreementMapper.toEntity(record);
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get agreement by ID
   */
  async getAgreementById(id: string): Promise<IWorkAndPayAgreement | null> {
    try {
      const { WorkAndPayAgreement } = getTenantModels();
      if (!id) throw new Error("Agreement id is required");
      const agreement = await WorkAndPayAgreement.findById(id)
        .populate("vehicle")
        .populate("owner")
        .populate({
          path: "driver",
          select: "-vehicle",
        });
      if (!agreement) return null;

      return WorkAndPayAgreementMapper.toEntity(agreement);
    } catch (error) {
      throw error;
    }
  }

  /**
   * Record a payment towards an agreement
   */
  async recordPayment(
    agreementId: string,
    payment: Omit<IPaymentRecord, "id" | "agreementId">,
  ): Promise<{
    updatedAgreement: IWorkAndPayAgreement;
    paymentRecord: IPaymentRecord;
  }> {
    const { WorkAndPayAgreement, PaymentRecord } = getTenantModels();
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      if (!agreementId) throw new Error("Agreement id is required");
      if (!payment) throw new Error("Payment data is required");

      const workAgreement =
        await WorkAndPayAgreement.findById(agreementId).session(session);
      if (!workAgreement) throw new Error("Agreement not found");

      const agreement = WorkAndPayAgreementMapper.toEntity(workAgreement);
      if (agreement.status === "Completed") {
        throw new Error("Agreement is already completed");
      }

      // Create payment record
      const newPayment = new PaymentRecord({
        workAndPayAgreementId: agreementId,
        amount: payment.amount,
        paymentDate: payment.paymentDate ?? new Date(),
        method: payment.method,
      });

      await newPayment.save({ session });

      // Update agreement stats
      const totalPaid = (agreement.amountPaid ?? 0) + payment.amount;
      const balance = Math.max(agreement.totalSalePrice - totalPaid, 0);
      const installmentsPaid = (agreement.installmentsPaid ?? 0) + 1;
      const installmentsRemaining = Math.max(
        (agreement.installmentsRemaining ?? 0) - 1,
        0,
      );

      workAgreement.amountPaid = totalPaid;
      workAgreement.balanceDue = balance;
      workAgreement.installmentsPaid = installmentsPaid;
      workAgreement.installmentsRemaining = installmentsRemaining;
      workAgreement.status = balance <= 0 ? "Completed" : "Ongoing";
      workAgreement.updatedAt = new Date();

      await workAgreement.save({ session });
      await session.commitTransaction();
      session.endSession();

      return {
        updatedAgreement: WorkAndPayAgreementMapper.toEntity(workAgreement),
        paymentRecord: PaymentRecordMapper.toEntity(newPayment),
      };
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  }

  /**
   * Get all payments for a given agreement
   */
  async getPaymentsByAgreementId(
    agreementId: string,
  ): Promise<IPaymentRecord[]> {
    try {
      const { PaymentRecord } = getTenantModels();
      if (!agreementId) throw new Error("Agreement id is required");
      const payments = await PaymentRecord.find({
        workAndPayAgreementId: agreementId,
      }).sort({
        paymentDate: -1,
      });
      return payments.map((p) => PaymentRecordMapper.toEntity(p));
    } catch (error) {
      throw error;
    }
  }

  // ✅ Assign all references directly from IDs
  private assignReferences(
    data: Partial<IWorkAndPayAgreement>,
  ): Partial<IWorkAndPayAgreement> {
    if (data.vehicleId) data.vehicle = data.vehicleId;
    if (data.ownerId) data.owner = data.ownerId;
    if (data.driverId) data.driver = data.driverId;
    return data;
  }
}
