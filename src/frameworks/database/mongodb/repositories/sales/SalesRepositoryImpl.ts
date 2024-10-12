import { injectable } from "inversify";
import {
  ISale,
  RequestQuery,
  PaginatedResponse,
  SalesRequestQuery,
} from "../../../../../entities";
import Sale, { SalesMapper } from "../../models/sales";
import { ISalesRepository } from "./ISalesRepository";

@injectable()
export class SalesRepositoryImpl implements ISalesRepository {
  async addSale(data: ISale): Promise<ISale> {
    try {
      if (!data) throw new Error("Sales data is required");
      const newSale = new Sale(data);
      await newSale.save();
      return SalesMapper.toEntity(newSale);
    } catch (error) {
      throw error;
    }
  }
  async updateSale(id: string, data: ISale): Promise<ISale> {
    try {
      if (!id) throw new Error("Sale id is required");
      if (!data) throw new Error("Sale data is required");

      const updatedSale = await Sale.findByIdAndUpdate(id, data, {
        new: true,
      });

      if (!updatedSale) throw new Error("Sale not found");

      return SalesMapper.toEntity(updatedSale);
    } catch (error) {
      throw error;
    }
  }
  async deleteSale(id: string): Promise<ISale> {
    try {
      if (!id) throw new Error("Sale id is required");
      const deletedSale = await Sale.findByIdAndDelete(id);
      if (!deletedSale) throw new Error("Sale not found");
      return SalesMapper.toEntity(deletedSale);
    } catch (error) {
      throw error;
    }
  }
  async findAll(query: SalesRequestQuery): Promise<PaginatedResponse<ISale>> {
    try {
      const { search, pageSize, status, driverId, vehicleId, companyId, date } =
        query;
      const searchQuery = search || "";
      const limit = pageSize || 10;
      const pageIndex = query.pageIndex || 1;
      const startIndex = (pageIndex - 1) * limit;
      let searchCriteria = {};

      // Add the $or condition for saleId
      if (searchQuery) {
        searchCriteria = {
          $or: [{ saleId: { $regex: new RegExp(`^${searchQuery}.*`, "i") } }],
        };
      }

      if (status) {
        searchCriteria = { ...searchCriteria, status };
      }
      if (driverId) {
        searchCriteria = {
          ...searchCriteria,
          driverId: driverId,
        };
      }
      if (vehicleId) {
        searchCriteria = {
          ...searchCriteria,
          vehicleId: vehicleId,
        };
      }
      if (companyId) {
        searchCriteria = {
          ...searchCriteria,
          companyId: companyId,
        };
      }
      if (date) {
        searchCriteria = {
          ...searchCriteria,
          date: date,
        };
      }

      // Populate user data to include the driver's full name
      const sales = await Sale.find(searchCriteria)
        .populate("vehicle")
        .populate({
          path: "driver", // Populate the driver
          populate: {
            path: "user",
            select: "-password", // Populate the user inside the driver
          },
        })
        .populate({
          path: "approvedOrRejectedBy", // Populate the driver
          select: "-password", // Populate the user inside the driver
        })
        .limit(limit)
        .skip(startIndex);

      const data: ISale[] = sales.map((driver) => SalesMapper.toEntity(driver));

      const totalCount = await Sale.countDocuments(searchCriteria);

      const totalPages = Math.ceil(totalCount / limit);

      const response: PaginatedResponse<ISale> = {
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
  async findById(id: string): Promise<ISale | null | undefined> {
    try {
      if (!id) throw new Error("Sale id is required");
      const sale = await Sale.findById(id)
        .populate("vehicle")
        .populate({
          path: "driver", // Populate the driver
          populate: {
            path: "user",
            select: "-password", // Populate the user inside the driver
          },
        })
        .populate({
          path: "approvedOrRejectedBy", // Populate the driver
          select: "-password", // Populate the user inside the driver
        });
      if (!sale) return null;
      return SalesMapper.toEntity(sale);
    } catch (error) {
      throw error;
    }
  }
}
