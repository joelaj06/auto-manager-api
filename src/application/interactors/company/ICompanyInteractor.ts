import { ICompany, PaginatedResponse, RequestQuery } from "../../../entities";

export interface ICompanyInteractor {
  addCompany(data: ICompany): Promise<ICompany>;
  getAllCompanies(query: RequestQuery): Promise<PaginatedResponse<ICompany>>;
  getACompany(id: string): Promise<ICompany>;
  updateCompany(id: string, data: ICompany): Promise<ICompany>;
}
