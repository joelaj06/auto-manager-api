import {
  IWorkAndPayAgreement,
  TWorkAndPayFrequency,
} from "../../../entities/WorkAndPay";

export interface IWorkAndPayInteractor {
  calculateInstallment(
    originalPrice: number,
    multiplier: number,
    durationYears: number,
    frequency: TWorkAndPayFrequency
  ): { totalSalePrice: number; installmentAmount: number };
  initiateAgreement(data: {
    ownerId: string;
    driverId: string;
    vehicleId: string;
    originalPrice: number;
    multiplier: number;
    durationYears: number;
    frequency: TWorkAndPayFrequency;
  }): Promise<IWorkAndPayAgreement>;
  processPayment(
    agreementId: string,
    amount: number,
    method: string,
    recordedByUserId: string
  ): Promise<IWorkAndPayAgreement>;
  getAgreementDetails(
    agreementId: string
  ): Promise<IWorkAndPayAgreement | null>;
}
