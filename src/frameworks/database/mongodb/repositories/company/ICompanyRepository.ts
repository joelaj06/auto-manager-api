import { PaginatedResponse, RequestQuery } from "../../../../../entities";
import { ICompany } from "../../../../../entities/Company";

export interface ICompanyRepository {
  addCompay(data: ICompany): Promise<ICompany>;
  findAllCompanies(query: RequestQuery): Promise<PaginatedResponse<ICompany>>;
  findCompanyById(id: string): Promise<ICompany | null | undefined>;
  updateCompany(id: string, data: ICompany): Promise<ICompany>;
}
