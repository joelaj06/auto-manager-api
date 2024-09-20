import { IAuthInteractor } from "../interface/IAuthInteractor";

export class AuthInteractor implements IAuthInteractor {
  test(): string {
    return "I'm alive 😁";
  }
}
