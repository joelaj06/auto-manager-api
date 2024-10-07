import { Request } from "express";
import { IUser } from "../../../entities/User";

export interface ControllerUserRequest extends Request {
  user?: IUser;
}
