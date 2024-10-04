export interface IErrorHandler {
  handleError(error: Error): void;
  isTrustedError(error: Error): boolean;
}

export const ERROR_HANDLER_TYPE = {
  ErrorHandler: Symbol.for("ErrorHandler"),
  ErrorMiddleWare: Symbol.for("ErrorMiddleWare"),
};
