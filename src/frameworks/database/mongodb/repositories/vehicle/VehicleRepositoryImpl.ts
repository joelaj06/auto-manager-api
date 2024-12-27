import { injectable } from "inversify";
import {
  IVehicle,
  RequestQuery,
  PaginatedResponse,
} from "../../../../../entities";
import { Vehicle, VehicleMapper } from "../../models/vehicle";
import { IVehicleRepository } from "./IVehicleRepository";
import mongoose from "mongoose";

@injectable()
export class VehicleRepositoryImpl implements IVehicleRepository {
  async findById(id: string): Promise<IVehicle | null | undefined> {
    try {
      if (!id) throw new Error("Vehicle id is required");
      const vehicle = await Vehicle.findById(id);
      if (!vehicle) return null;
      return VehicleMapper.toEntity(vehicle);
    } catch (error) {
      throw error;
    }
  }
  async findAllVehicles(
    query: RequestQuery
  ): Promise<PaginatedResponse<IVehicle>> {
    try {
      const { search, pageSize, companyId } = query;
      const searchQuery = search || "";
      const limit = pageSize || 10;
      const pageIndex = query.pageIndex || 1;
      const startIndex = (pageIndex - 1) * limit;

      let searchCriteria = {};

      if (companyId) {
        searchCriteria = {
          ...searchCriteria,
          company: new mongoose.Types.ObjectId(companyId),
        };
      }

      searchCriteria = {
        ...searchCriteria,
        $or: [
          { licensePlate: { $regex: new RegExp(`^${searchQuery}.*`, "i") } },
          { make: { $regex: new RegExp(`^${searchQuery}.*`, "i") } },
          { model: { $regex: new RegExp(`^${searchQuery}.*`, "i") } },
          { color: { $regex: new RegExp(`^${searchQuery}.*`, "i") } },
          { vin: { $regex: new RegExp(`^${searchQuery}.*`, "i") } },
        ],
      };
      const vehicles = await Vehicle.find(searchCriteria)
        .limit(limit)
        .skip(startIndex);

      const data: IVehicle[] = vehicles.map((vehicle) =>
        VehicleMapper.toEntity(vehicle)
      );
      const totalCount = await Vehicle.countDocuments(searchCriteria);
      const totalPages = Math.ceil(totalCount / limit);
      const response: PaginatedResponse<IVehicle> = {
        data,
        totalPages,
        totalCount,
        pageCount: pageIndex,
      };
      return response;
    } catch (error) {
      throw error;
    }
  }
  async addVehicle(data: IVehicle): Promise<IVehicle> {
    try {
      if (!data) throw new Error("Vehicle data is required");
      const newVehicle = new Vehicle(data);
      await newVehicle.save();
      return VehicleMapper.toEntity(newVehicle);
    } catch (error) {
      throw error;
    }
  }
  async updateVehicle(id: string, data: IVehicle): Promise<IVehicle> {
    try {
      if (!id) throw new Error("Vehicle id is required");
      if (!data) throw new Error("Vehicle data is required");

      const updatedVehicle = await Vehicle.findByIdAndUpdate(id, data, {
        new: true,
      });

      if (!updatedVehicle) throw new Error("Vehicle not found");

      return VehicleMapper.toEntity(updatedVehicle);
    } catch (error) {
      throw error;
    }
  }
  async deleteVehicle(id: string): Promise<IVehicle> {
    try {
      if (!id) throw new Error("Vehicle id is required");
      const deletedVehicle = await Vehicle.findByIdAndUpdate(
        id,
        {
          isDeleted: true,
          deletedAt: new Date(),
        },
        {
          new: true,
        }
      );
      if (!deletedVehicle) throw new Error("Vehicle not found");
      return VehicleMapper.toEntity(deletedVehicle);
    } catch (error) {
      throw error;
    }
  }
}
