import { inject, injectable } from "inversify";
import { IUser, RequestQuery } from "../../../entities/User";
import { UnprocessableEntityError } from "../../../error_handler/UnprocessableEntityError";
import { IUserInteractor } from "./IUserInteractor";
import { IUserRepository } from "../../../frameworks/database/mongodb/repositories";
import { INTERFACE_TYPE } from "../../../utils";
import { BadRequestError, NotFoundError } from "../../../error_handler";
import { PaginatedResponse } from "../../../entities/UserResponse";
import { IAuthService } from "../../../frameworks/services/auth/IAuthService";
import { IDriverRepository } from "../../../frameworks/database/mongodb/repositories/driver/IDriverRepository";
import { IDriver } from "../../../entities";
import { IStorageBucket } from "../../../frameworks";

@injectable()
export class UserInteractorImpl implements IUserInteractor {
  private userRepository: IUserRepository;
  private authService: IAuthService;
  private driverRepository: IDriverRepository;
  private bucket: IStorageBucket;
  constructor(
    @inject(INTERFACE_TYPE.UserRepositoryImpl) userRepository: IUserRepository,
    @inject(INTERFACE_TYPE.AuthServiceImpl) authService: IAuthService,
    @inject(INTERFACE_TYPE.DriverRepositoryImpl)
    driverRepository: IDriverRepository,
    @inject(INTERFACE_TYPE.StorageBucketImpl) bucket: IStorageBucket
  ) {
    this.userRepository = userRepository;
    this.authService = authService;
    this.driverRepository = driverRepository;
    this.bucket = bucket;
  }
  async getAUser(id: string): Promise<IUser> {
    if (!id) throw new UnprocessableEntityError("User id is required");
    const user = await this.userRepository.findUserById(id);
    if (!user) throw new NotFoundError("User not found");
    const { password: pass, ...rest } = user;
    return { ...rest };
  }
  async deleteUser(id: string): Promise<IUser> {
    if (!id) throw new UnprocessableEntityError("User id is required");
    const deletedUser = await this.userRepository.deleteUser(id);
    if (!deletedUser) throw new BadRequestError("Error deleting user");
    return deletedUser;
  }

  async addUser(data: IUser): Promise<IUser> {
    if (!data) throw new UnprocessableEntityError("User data is required");
    //TODO validate data
    const existingUser = await this.userRepository.findUserByEmail(data.email!);
    if (existingUser) throw new BadRequestError("The email already exists");
    let userData = { ...data };
    if (data.role && data.role.name?.toLowerCase() === "driver") {
      userData = data;
    } else {
      const hashedPassword = await this.authService.encriptPassword(
        data.password!
      );
      userData = {
        ...data,
        password: hashedPassword,
      };
    }

    const newUser = await this.userRepository.addUser(userData);
    if (!newUser) throw new BadRequestError("Error while adding user");
    const { password: pass, ...rest } = newUser;

    //check if user is a driver by role
    if (newUser.role && newUser.role.name?.toLowerCase() === "driver") {
      const driverData: IDriver = {
        userId: newUser._id,
        vehicleId: data.vehicleId || undefined,
        vehicle: data.vehicleId || undefined,
        user: newUser._id,
        companyId: data.company,
        lisenceExpiryDate: data.lisenceExpiryDate,
        licenseNumber: data.licenseNumber,
        company: data.company,
      };

      const dirver = await this.driverRepository.addDriver(driverData);
      if (!dirver) throw new Error("Error while adding driver");
    }

    return { ...rest };
  }
  getAllUsers(query: RequestQuery): Promise<PaginatedResponse<IUser>> {
    return this.userRepository.findAllUsers(query);
  }
  async updateUser(id: string, data: IUser): Promise<IUser> {
    if (!id) throw new UnprocessableEntityError("User id is required");
    if (!data) throw new UnprocessableEntityError("User data is required");

    let body = { ...data };
    const user = await this.userRepository.findUserById(id);
    if (!user) throw new NotFoundError("User not found");

    let image: string = data.imageUrl || "";

    if (!image.startsWith("http") && image != "") {
      // Image is in base64 format, so upload it
      const imageUrl = await this.bucket.uploadImage(image);
      body = { ...body, imageUrl: imageUrl };
    } else {
      body = { ...body, imageUrl: "" };
    }

    const updatedUser = await this.userRepository.updateUser(id, body);

    //check if user is a driver by role
    if (updatedUser.role && updatedUser.role.name?.toLowerCase() === "driver") {
      const driverData: IDriver = {
        userId: updatedUser._id,
        vehicleId: data.vehicleId,
        vehicle: data.vehicleId,
        user: updatedUser._id,
        companyId: data.company,
        lisenceExpiryDate: data.lisenceExpiryDate,
        licenseNumber: data.licenseNumber,
      };

      const driver = await this.driverRepository.findDriverByUserId(
        updatedUser._id!
      );

      if (!driver) throw new NotFoundError("Driver not found");

      const dirver = await this.driverRepository.updateDriver(
        driver._id!,
        driverData
      );
      if (!dirver) throw new BadRequestError("Error while adding driver");
    }

    if (!updatedUser) throw new Error("Error while updating user");
    return updatedUser;
  }
}
