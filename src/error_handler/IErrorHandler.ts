export interface IErrorHandler {
  handleError(error: Error): void;
  isTrustedError(error: Error): boolean;
}
