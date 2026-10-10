import { HttpException } from '@nestjs/common';
import { ERROR_HTTP_STATUS, ErrorCode } from './error-codes';

/** Throw this from services for any documented, client-actionable failure. */
export class ApiError extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message, ERROR_HTTP_STATUS[code]);
  }
}
