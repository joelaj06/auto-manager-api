export class IVehicle {
  constructor(
    public readonly _id?: string,
    public vehicleId?: string,
    public readonly licensePlate?: string,
    public readonly make?: string,
    public readonly model?: string,
    public readonly year?: number,
    public readonly color?: string,
    public readonly vin?: string,
    public readonly ownerId?: string,
    public readonly status?: string,
    public readonly currentDriverId?: string,
    public readonly salesHistory?: SalesHistory[],
    public readonly maintenanceRecords?: MaintenanceRecord[],
    public readonly rentalStatus?: boolean,
    public readonly rentalHistory?: RentalHistory[],
    public readonly insuranceDetails?: InsuranceDetails,
    public readonly createdBy?: string,
    public readonly createdAt?: string,
    public readonly updatedAt?: string,
    public readonly image?: string
  ) {}
}

export class SalesHistory {
  constructor(
    public readonly saleId: string,
    public readonly amount: number,
    public readonly date: string
  ) {}
}

export class MaintenanceRecord {
  constructor(
    public readonly maintenanceId: string,
    public readonly serviceType: string,
    public readonly cost: number,
    public readonly date: string
  ) {}
}

export class RentalHistory {
  constructor(
    public readonly rentalId: string,
    public readonly renterName: string,
    public readonly startDate: string,
    public readonly endDate: string,
    public readonly cost: number
  ) {}
}

export class InsuranceDetails {
  constructor(
    public readonly provider: string,
    public readonly policyNumber: string,
    public readonly expiryDate: string
  ) {}
}
