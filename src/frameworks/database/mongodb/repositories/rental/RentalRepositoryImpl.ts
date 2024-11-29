import { injectable } from "inversify";
import { IRentalRepository } from "./IRentalRepository";
import {
  RequestQuery,
  PaginatedResponse,
  IRental,
  RentalRequestQuery,
} from "../../../../../entities";
import Rental, { RentalMapper } from "../../models/rental";
import mongoose from "mongoose";

@injectable()
export class RentalRepositoryImpl implements IRentalRepository {
  async findAll(
    query: RentalRequestQuery
  ): Promise<PaginatedResponse<IRental>> {
    try {
      const {
        search,
        pageSize,
        status,
        startDate,
        endDate,
        vehicleId,
        companyId,
        renter,
      } = query;
      const searchQuery = search || "";
      const limit = pageSize || 10;
      const pageIndex = query.pageIndex || 1;
      const startIndex = (pageIndex - 1) * limit;
      let searchCriteria = {};

      if (searchQuery) {
        searchCriteria = {
          $or: [
            { rentalCode: { $regex: new RegExp(`^${searchQuery}.*`, "i") } },
          ],
        };
      }

      if (renter) {
        searchCriteria = {
          ...searchCriteria,
          renter: new mongoose.Types.ObjectId(renter),
        };
      }

      if (companyId)
        searchCriteria = {
          ...searchCriteria,
          company: new mongoose.Types.ObjectId(companyId),
        };

      if (status) {
        searchCriteria = {
          ...searchCriteria,
          status,
        };
      }

      if (startDate && endDate) {
        searchCriteria = {
          ...searchCriteria,
          date: {
            $gte: new Date(startDate),
            $lte: new Date(endDate ?? new Date()),
          },
        };
      }

      if (vehicleId) {
        searchCriteria = {
          ...searchCriteria,
          vehicle: vehicleId,
        };
      }

      const rentals = await Rental.find(searchCriteria)
        .limit(limit)
        .skip(startIndex)
        .populate("renter", "-password")
        .populate(
          "vehicle",
          "-rentalHistory -createdAt -updatedAt -__v -maintenanceRecords -salesHistory -insuranceDetails"
        )
        .populate("updatedBy", "-password")
        .populate("createdBy", "-password");

      const data: IRental[] = rentals.map((category) =>
        RentalMapper.toEntity(category)
      );

      // Aggregate to calculate total rentals sum
      // Perform aggregation conditionally
      const aggregationPipeline = [];
      if (Object.keys(searchCriteria).length > 0) {
        aggregationPipeline.push({ $match: searchCriteria });
      }
      aggregationPipeline.push({
        $group: { _id: null, totalRentals: { $sum: "$totalAmount" } },
      });

      const totalRentalsAggregation = await Rental.aggregate(
        aggregationPipeline
      );

      const totalRentals = totalRentalsAggregation[0]?.totalRentals || 0;

      const totalCount = await Rental.countDocuments(searchCriteria);

      const totalPages = Math.ceil(totalCount / limit);

      const paginatedRes: PaginatedResponse<IRental> = {
        totalSum: totalRentals,
        data,
        totalPages,
        totalCount,
        pageCount: pageIndex,
      };

      return paginatedRes;
    } catch (error) {
      throw error;
    }
  }
  async findById(id: string): Promise<IRental | null | undefined> {
    if (!id) throw new Error("Rental id is required");
    const rental = await Rental.findById(id)
      .populate("renter", "-password")
      .populate(
        "vehicle",
        "-rentalHistory -createdAt -updatedAt -__v -maintenanceRecords -salesHistory -insuranceDetails"
      )
      .populate("updatedBy", "-password")
      .populate("createdBy", "-password");
    if (!rental) return null;
    return RentalMapper.toEntity(rental);
  }
  async save(data: IRental): Promise<IRental> {
    try {
      if (!data) throw new Error("Rental data is required");
      const newRental = new Rental(data);
      await newRental.save();
      if (!newRental) {
        throw new Error("Error while adding rental");
      }
      const rental = await Rental.findById(newRental._id)
        .populate("renter", "-password")
        .populate(
          "vehicle",
          "-rentalHistory -createdAt -updatedAt -__v -maintenanceRecords -salesHistory -insuranceDetails"
        )
        .populate("updatedBy", "-password")
        .populate("createdBy", "-password");
      return RentalMapper.toEntity(rental);
    } catch (error) {
      throw error;
    }
  }
  async update(id: string, data: IRental): Promise<IRental> {
    try {
      if (!id) throw new Error("Rental id is required");
      if (!data) throw new Error("Rental data is required");

      const updatedRental = await Rental.findByIdAndUpdate(id, data, {
        new: true,
      })
        .populate("renter", "-password")
        .populate(
          "vehicle",
          "-rentalHistory -createdAt -updatedAt -__v -maintenanceRecords -salesHistory -insuranceDetails"
        )
        .populate("updatedBy", "-password")
        .populate("createdBy", "-password");

      if (!updatedRental) throw new Error("Rental not found");

      return RentalMapper.toEntity(updatedRental);
    } catch (error) {
      throw error;
    }
  }
  async delete(id: string): Promise<IRental> {
    try {
      if (!id) throw new Error("Expense id is required");
      const deletedRental = await Rental.findByIdAndUpdate(
        id,
        {
          isDeleted: true,
          deletedAt: new Date(),
        },
        {
          new: true,
        }
      );
      if (!deletedRental) throw new Error("Rental not found");
      return RentalMapper.toEntity(deletedRental);
    } catch (error) {
      throw error;
    }
  }
}
