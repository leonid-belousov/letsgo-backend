import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Reads the `Idempotency-Key` request header (undefined when absent). */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const header = ctx.switchToHttp().getRequest<Request>().headers['idempotency-key'];
    return Array.isArray(header) ? header[0] : header;
  },
);
