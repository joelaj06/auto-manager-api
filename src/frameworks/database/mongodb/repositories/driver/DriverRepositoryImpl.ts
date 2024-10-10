import { injectable } from "inversify";
import {
  RequestQuery,
  IDriver,
  PaginatedResponse,
} from "../../../../../entities";
import Driver, { DriverMapper } from "../../models/driver";
import { IDriverRepository } from "./IDriverRepository";

@injectable()
export class DriverRepositoryImpl implements IDriverRepository {
  async findAll(query: RequestQuery): Promise<PaginatedResponse<IDriver>> {
    try {
      const { search, pageSize } = query;
      const searchQuery = search || "";
      const limit = pageSize || 10;
      const pageIndex = query.pageIndex || 1;
      const startIndex = (pageIndex - 1) * limit;
      const searchCriteria = {
        $or: [
          { licenseNumber: { $regex: new RegExp(`^${searchQuery}.*`, "i") } },
          { "user.name": { $regex: new RegExp(`^${searchQuery}.*`, "i") } },
        ],
      };
      const drivers = await Driver.find(searchCriteria)
        .populate("user", "-password")
        .limit(limit)
        .skip(startIndex);

      const data: IDriver[] = drivers.map((driver) =>
        DriverMapper.toEntity(driver)
      );
      const totalCount = await Driver.countDocuments(searchCriteria);
      const totalPages = Math.ceil(totalCount / limit);
      const response: PaginatedResponse<IDriver> = {
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

  async findById(id: string): Promise<IDriver | null | undefined> {
    try {
      if (!id) throw new Error("Driver id is required");
      const vehicle = await Driver.findById(id);
      if (!vehicle) return null;
      return DriverMapper.toEntity(vehicle);
    } catch (error) {
      throw error;
    }
  }
  async addDriver(data: IDriver): Promise<IDriver> {
    try {
      if (!data) throw new Error("Driver data is required");
      const newDriver = new Driver(data);
      await newDriver.save();
      return DriverMapper.toEntity(newDriver);
    } catch (error) {
      throw error;
    }
  }
  async updateDriver(id: string, data: IDriver): Promise<IDriver> {
    try {
      if (!id) throw new Error("Driver id is required");
      if (!data) throw new Error("Driver data is required");

      const updatedDriver = await Driver.findByIdAndUpdate(id, data, {
        new: true,
      });

      if (!updatedDriver) throw new Error("Driver not found");

      return DriverMapper.toEntity(updatedDriver);
    } catch (error) {
      throw error;
    }
  }
  async deleteDriver(id: string): Promise<IDriver> {
    try {
      if (!id) throw new Error("Driver id is required");
      const deletedDriver = await Driver.findByIdAndDelete(id);
      if (!deletedDriver) throw new Error("Driver not found");
      return DriverMapper.toEntity(deletedDriver);
    } catch (error) {
      throw error;
    }
  }
}
