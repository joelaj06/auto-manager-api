import { inject, injectable } from "inversify";
import { IUser, UserRequestQuery } from "../../../entities/User";
import { UnprocessableEntityError } from "../../../error_handler/UnprocessableEntityError";
import { IUserInteractor } from "./IUserInteractor";
import { IUserRepository } from "../../../frameworks/database/mongodb/repositories";
import { INTERFACE_TYPE } from "../../../utils";
import { BadRequestError, NotFoundError } from "../../../error_handler";
import { PaginatedResponse } from "../../../entities/UserResponse";
import { IAuthService } from "../../../frameworks/services/auth/IAuthService";

@injectable()
export class UserInteractorImpl implements IUserInteractor {
  private userRepository: IUserRepository;
  private authService: IAuthService;
  constructor(
    @inject(INTERFACE_TYPE.UserRepositoryImpl) userRepository: IUserRepository,
    @inject(INTERFACE_TYPE.AuthServiceImpl) authService: IAuthService
  ) {
    this.userRepository = userRepository;
    this.authService = authService;
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

    const hashedPassword = await this.authService.encriptPassword(
      data.password!
    );
    const userData = {
      ...data,
      password: hashedPassword,
    };
    const newUser = await this.userRepository.addUser(userData);
    if (!newUser) throw new BadRequestError("Error while adding user");
    const { password: pass, ...rest } = newUser;
    return { ...rest };
  }
  getAllUsers(query: UserRequestQuery): Promise<PaginatedResponse<IUser>> {
    return this.userRepository.findAllUsers(query);
  }
  async updateUser(id: string, data: IUser): Promise<IUser> {
    if (!id) throw new UnprocessableEntityError("User id is required");
    if (!data) throw new UnprocessableEntityError("User data is required");

    const user = await this.userRepository.findUserById(id);
    if (!user) throw new NotFoundError("User not found");

    const updatedUser = await this.userRepository.updateUser(id, data);
    if (!updatedUser) throw new Error("Error while updating user");
    return updatedUser;
  }
}
