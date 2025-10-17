import { IVehicleRepository, IWorkAndPayRepository } from "../../../frameworks";
import { WorkAndPayInteractorImpl } from "./WorkAndPayInteractorImpl";

describe("WorkAndPayInteractorImpl", () => {
  let workAndPayInteractor: WorkAndPayInteractorImpl;
  let mockWorkAndPayRepo: jest.Mocked<IWorkAndPayRepository>;
  let mockVehicleRepository: jest.Mocked<IVehicleRepository>;

  beforeEach(() => {
    // Initialize mocked repository methods
    mockWorkAndPayRepo = {
      initiateAgreement: jest.fn(), // Mock for initiating a work and pay agreement
      getAgreementById: jest.fn(), // Mock for getting an agreement by ID
      recordPayment: jest.fn(), // Mock for recording a payment
    } as any;

    mockVehicleRepository = {} as any; // No methods required for this test

    // Instantiate WorkAndPayInteractor with mocked repositories
    workAndPayInteractor = new WorkAndPayInteractorImpl(
      mockWorkAndPayRepo,
      mockVehicleRepository
    );
  });

  describe("calculateInstallment", () => {
    it("should correctly calculate installment details", () => {
      const originalPrice = 50000;
      const multiplier = 2;
      const durationYears = 3;
      const finalPrice = 100000;
      const frequency = "weekly";

      const result = workAndPayInteractor.calculateInstallment(
        originalPrice,
        multiplier,
        durationYears,
        finalPrice,
        frequency
      );

      expect(result.totalSalePrice).toBe(100000);
      expect(result.installmentAmount).toBe(641.03); // 100000 / (3*52) rounded up to 2 decimal places
    });
  });
});
