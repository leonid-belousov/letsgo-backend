import { ERROR_HTTP_STATUS, ErrorCode } from './error-codes';

describe('error contract', () => {
  it('maps every documented error code to an HTTP status', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
    expect(ErrorCode.CAPACITY_CHANGED).toBe('CAPACITY_CHANGED');
  });
});
