import { injectable } from "inversify";
import { ICompany } from "../../../../../entities/Company";
import { ICompanyRepository } from "./ICompanyRepository";
import { UnprocessableEntityError } from "../../../../../error_handler";
import Company, { CompanyMapper } from "../../models/company";

@injectable()
export class CompanyRepositoryImpl implements ICompanyRepository {
  async addCompay(data: ICompany): Promise<ICompany> {
    if (!data) throw new UnprocessableEntityError("Company data is required");
    const newCompany = new Company(data);
    await newCompany.save();
    return CompanyMapper.toEntity(newCompany);
  }
}
