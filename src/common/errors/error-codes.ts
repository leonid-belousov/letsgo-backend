/**
 * Machine-readable API error codes. Clients map these to user-facing messages
 * (Handoff §19/§20). Do not add ad-hoc error strings elsewhere.
 */
export const ErrorCode = {
  // Documented (Handoff §20)
  VALIDATION: 'VALIDATION',
  ACCESS_DENIED: 'ACCESS_DENIED',
  EXPIRED: 'EXPIRED',
  CAPACITY_CHANGED: 'CAPACITY_CHANGED',
  BOOKING_CONFLICT: 'BOOKING_CONFLICT',
  VERSION_CHANGED: 'VERSION_CHANGED',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  // Infrastructural (technical decision, not from the product docs)
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT', // uniqueness / state conflicts (e.g. username taken)
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  ACCESS_DENIED: 403,
  EXPIRED: 410,
  CAPACITY_CHANGED: 409,
  BOOKING_CONFLICT: 409,
  VERSION_CHANGED: 409,
  UPLOAD_FAILED: 422,
  UNAUTHENTICATED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  RATE_LIMITED: 429,
  PROVIDER_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Field-level or contextual details; never contains private data. */
    details?: Record<string, unknown>;
    requestId?: string;
  };
}
