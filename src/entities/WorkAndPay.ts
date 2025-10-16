/**
 * Represents a single Work and Pay agreement between the owner and a driver.
 */
export class IWorkAndPayAgreement {
  constructor(
    public readonly id: string,
    public readonly ownerId: string,
    public readonly driverId: string,
    public readonly vehicleId: string,
    public readonly originalVehiclePrice: number,
    public readonly totalSalePrice: number,
    public readonly installmentAmount: number,
    public readonly paymentFrequency: TWorkAndPayFrequency,
    public readonly durationYears: number,
    public readonly amountPaid: number,
    public readonly balanceDue: number,
    public readonly installmentsPaid: number,
    public readonly installmentsRemaining: number,
    public readonly status: TWorkAndPayStatus,
    public readonly startDate: string,
    public readonly completionDate: string | null
  ) {}
}

export type TWorkAndPayFrequency = "weekly" | "monthly";
export type TWorkAndPayStatus = "Active" | "Completed" | "Defaulted";
