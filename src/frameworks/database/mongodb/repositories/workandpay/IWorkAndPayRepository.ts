import { IWorkAndPayAgreement } from "../../../../../entities/WorkAndPay";
import { IPaymentRecord } from "../../../../../entities/PaymentRecord";

export interface IWorkAndPayRepository {
  /**
   * Create a new Work & Pay agreement
   */
  createAgreement(
    agreement: Omit<IWorkAndPayAgreement, "id" | "agreementId">
  ): Promise<IWorkAndPayAgreement>;

  /**
   * Get agreement by ID
   */
  getAgreementById(id: string): Promise<IWorkAndPayAgreement | null>;

  /**
   * Record a payment towards an agreement
   */
  recordPayment(
    agreementId: string,
    payment: Omit<IPaymentRecord, "id" | "agreementId" | "paymentId">
  ): Promise<{
    updatedAgreement: IWorkAndPayAgreement;
    paymentRecord: IPaymentRecord;
  }>;
  /**
   * Get all payments for a given agreement
   */
  getPaymentsByAgreementId(agreementId: string): Promise<IPaymentRecord[]>;
}
