import { RentalInteractorImpl } from "./RentalInteractorImpl";
import { IRentalRepository, IVehicleRepository } from "../../../frameworks";
import { IRental } from "../../../entities";
import { describe, expect, it, beforeEach } from "@jest/globals";

describe("RentalInteractorImpl - removeExtension", () => {
  let rentalInteractor: RentalInteractorImpl;
  let mockRentalRepository: jest.Mocked<IRentalRepository>;
  let mockVehicleRepository: jest.Mocked<IVehicleRepository>;

  beforeEach(() => {
    // Initialize mocked repository methods
    mockRentalRepository = {
      findById: jest.fn(), // Mock for finding a rental by ID
      update: jest.fn(), // Mock for updating rental data
    } as any;

    mockVehicleRepository = {} as any; // No methods required for this test

    // Instantiate RentalInteractor with mocked repositories
    rentalInteractor = new RentalInteractorImpl(
      mockRentalRepository,
      mockVehicleRepository
    );
  });

  it("should successfully remove extensions and update the rental object", async () => {
    // Mock data setup
    const rentalId = "123"; // Sample rental ID
    const initialRental: IRental = {
      _id: rentalId,
      totalAmount: 1000, // Initial total amount
      balance: -500, // Initial balance
      extensions: [
        { extendedAmount: 100 }, // Extension at index 0
        { extendedAmount: 200 }, // Extension at index 1
        { extendedAmount: 300 }, // Extension at index 2
      ],
    };
    const removalIndexes = [0]; // Indices of extensions to be removed

    const expectedUpdatedRental: IRental = {
      _id: rentalId,
      totalAmount: 900, // Updated total amount after removing extensions
      balance: -400, // Updated balance
      extensions: [
        { extendedAmount: 200 }, // Extension at index 1
        { extendedAmount: 300 },
      ], // Remaining extensions
    };

    // Mock repository behaviors
    mockRentalRepository.findById.mockResolvedValue(initialRental); // Simulate finding the rental
    mockRentalRepository.update.mockResolvedValue(expectedUpdatedRental); // Simulate updating the rental

    // Invoke the method under test
    const result = await rentalInteractor.removeExtension(
      rentalId,
      removalIndexes
    );

    // Assertions: Ensure the findById method is called with the correct rental ID
    expect(mockRentalRepository.findById).toHaveBeenCalledWith(rentalId);

    // Assertions: Ensure the update method is called with the correct updated data
    expect(mockRentalRepository.update).toHaveBeenCalledWith(rentalId, {
      ...initialRental,
      totalAmount: 900, // Expected updated total amount
      balance: -400, // Expected updated balance
      extensions: [
        { extendedAmount: 200 }, // Extension at index 1
        { extendedAmount: 300 },
      ], // Expected remaining extensions
    });

    // Assertions: Ensure the returned result matches the expected updated rental object
    expect(result).toEqual(expectedUpdatedRental);
  });
});