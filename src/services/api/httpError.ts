export class HttpError extends Error {
  public statusCode: number;
  public errorCode: string;
  public field?: string;

  constructor(statusCode: number, errorCode: string, message: string, field?: string) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.field = field;
  }
}
