/**
 * Represents a payment made towards a Work and Pay agreement.
 */

export class IPaymentRecord {
  constructor(
    public readonly id: string,
    public readonly workAndPayAgreementId: string,
    public readonly amount: number,
    public readonly paymentDate: string,
    public readonly method: string,
    public readonly recordedBy?: string
  ) {}
}
