import { injectable } from "inversify";
import { ICompany } from "../../../../../entities/Company";
import { ICompanyRepository } from "./ICompanyRepository";
import {
  BadRequestError,
  NotFoundError,
  UnprocessableEntityError,
} from "../../../../../error_handler";
import Company, { CompanyMapper } from "../../models/company";
import { PaginatedResponse, RequestQuery } from "../../../../../entities";

@injectable()
export class CompanyRepositoryImpl implements ICompanyRepository {
  async updateCompany(id: string, data: ICompany): Promise<ICompany> {
    try {
      const company = await Company.findById(id);
      if (!company) throw new NotFoundError("Company not found");
      const updatedCompany = await Company.findByIdAndUpdate(id, data, {
        new: true,
      });
      if (!updatedCompany)
        throw new BadRequestError("Error while updating company");
      return CompanyMapper.toEntity(updatedCompany);
    } catch (error) {
      throw error;
    }
  }
  async findCompanyById(id: string): Promise<ICompany | null | undefined> {
    const company = await Company.findById(id);
    if (company) {
      return CompanyMapper.toEntity(company);
    } else {
      return null;
    }
  }
  async findAllCompanies(
    query: RequestQuery
  ): Promise<PaginatedResponse<ICompany>> {
    try {
      const searchQuery = query.search || "";
      const limit = query.pageSize || 10;
      const pageIndex = query.pageIndex || 1;
      const startIndex = (pageIndex - 1) * limit;
      const searchCriteria = {
        $or: [
          { name: { $regex: new RegExp(`^${searchQuery}.*`, "i") } },
          { indeustry: { $regex: new RegExp(`^${searchQuery}.*`, "i") } },
          {
            taxIdentificationNumber: {
              $regex: new RegExp(`^${searchQuery}.*`, "i"),
            },
          },
          {
            registrationNumber: {
              $regex: new RegExp(`^${searchQuery}.*`, "i"),
            },
          },
        ],
      };

      const companies = await Company.find(searchCriteria)
        .limit(limit)
        .skip(startIndex);

      if (companies) {
        const data: ICompany[] = companies.map((company) =>
          CompanyMapper.toEntity(company)
        );
        const totalCount: number = await Company.countDocuments(searchCriteria);
        // Calculate total pages
        const totalPages = Math.ceil(totalCount / limit);
        const paginatedRes: PaginatedResponse<ICompany> = {
          data,
          totalPages,
          totalCount,
          pageCount: pageIndex,
        };
        return paginatedRes;
      } else {
        throw new Error();
      }
    } catch (error) {
      throw error;
    }
  }
  async addCompay(data: ICompany): Promise<ICompany> {
    try {
      if (!data) throw new UnprocessableEntityError("Company data is required");
      const newCompany = new Company(data);
      await newCompany.save();
      return CompanyMapper.toEntity(newCompany);
    } catch (error) {
      throw error;
    }
  }
}
