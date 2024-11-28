import { inject, injectable } from "inversify";
import {
  ICompany,
  IUser,
  PaginatedResponse,
  RequestQuery,
} from "../../../entities";
import {
  ICompanyRepository,
  IStorageBucket,
  IUserRepository,
} from "../../../frameworks";
import { INTERFACE_TYPE } from "../../../utils";
import { ICompanyInteractor } from "./ICompanyInteractor";
import {
  BadRequestError,
  NotFoundError,
  UnprocessableEntityError,
} from "../../../error_handler";

@injectable()
export class CompanyInteractorImpl implements ICompanyInteractor {
  private repository: ICompanyRepository;
  private userRepository: IUserRepository;
  private bucket: IStorageBucket;

  constructor(
    @inject(INTERFACE_TYPE.CompanyRepositoryImpl)
    repository: ICompanyRepository,
    @inject(INTERFACE_TYPE.UserRepositoryImpl) userRepository: IUserRepository,
    @inject(INTERFACE_TYPE.StorageBucketImpl) bucket: IStorageBucket
  ) {
    this.repository = repository;
    this.userRepository = userRepository;
    this.bucket = bucket;
  }
  async updateCompany(id: string, data: ICompany): Promise<ICompany> {
    if (!id) throw new UnprocessableEntityError("Company id is required");
    const company = await this.repository.findCompanyById(id);
    if (!company) throw new NotFoundError("Company not found");

    //get and upload company logo
    let body = { ...data };

    let image: string = data.logoUrl || "";

    if (!image.startsWith("http") && image != "") {
      // Image is in base64 format, so upload it
      const imageUrl = await this.bucket.uploadImage(image);
      body = { ...body, logoUrl: imageUrl };
    } else {
      body = { ...body, logoUrl: image };
    }

    const updatedCompany = await this.repository.updateCompany(id, body);
    if (!updatedCompany)
      throw new BadRequestError("Error while updating company");
    return updatedCompany;
  }

  async getACompany(id: string): Promise<ICompany> {
    if (!id) throw new UnprocessableEntityError("Company id is required");
    const company = await this.repository.findCompanyById(id);
    if (!company) throw new NotFoundError("Company not found");
    return company;
  }
  async getAllCompanies(
    query: RequestQuery
  ): Promise<PaginatedResponse<ICompany>> {
    return await this.repository.findAllCompanies(query);
  }
  async addCompany(data: ICompany): Promise<ICompany> {
    if (!data) throw new UnprocessableEntityError("Company data is required");
    //get and upload company logo
    let body = { ...data };

    let image: string = data.logoUrl || "";

    if (!image.startsWith("http") && image != "") {
      // Image is in base64 format, so upload it
      const imageUrl = await this.bucket.uploadImage(image);
      body = { ...body, logoUrl: imageUrl };
    } else {
      body = { ...body, logoUrl: "" };
    }

    const company = await this.repository.addCompay(body);
    if (!company) throw new BadRequestError("Error while adding company");
    const userData: IUser = {
      company: company._id,
      companyId: company._id,
    };
    await this.userRepository.updateUser(data.ownerId!, userData);
    return company;
  }
}
