import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ApiError } from './api-error';
import { ApiErrorBody, ERROR_HTTP_STATUS, ErrorCode } from './error-codes';

const STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
  400: ErrorCode.VALIDATION,
  401: ErrorCode.UNAUTHENTICATED,
  403: ErrorCode.ACCESS_DENIED,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  429: ErrorCode.RATE_LIMITED,
};

/** Converts every thrown error into the common {@link ApiErrorBody} envelope. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const requestId = typeof req.id === 'string' ? req.id : undefined;

    let code: ErrorCode = ErrorCode.INTERNAL;
    let message = 'Internal server error';
    let details: Record<string, unknown> | undefined;
    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;

    if (exception instanceof ApiError) {
      code = exception.code;
      message = exception.message;
      details = exception.details;
      status = ERROR_HTTP_STATUS[code];
    } else if (exception instanceof ThrottlerException) {
      code = ErrorCode.RATE_LIMITED;
      status = 429;
      message = 'Too many requests';
    } else if (exception instanceof BadRequestException) {
      code = ErrorCode.VALIDATION;
      status = 400;
      message = 'Validation failed';
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null && 'message' in body) {
        details = { issues: (body as { message: unknown }).message };
      }
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = STATUS_TO_CODE[status] ?? ErrorCode.INTERNAL;
      message = exception.message;
    } else {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    const body: ApiErrorBody = { error: { code, message, details, requestId } };
    res.status(status).json(body);
  }
}
