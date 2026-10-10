process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://letsgo:letsgo_local_password@localhost:5432/letsgo?schema=public';
process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.THROTTLE_DISABLED = 'true';
process.env.PASSWORD_SCRYPT_LOG_N = '10';
// many parallel jest workers share one PostgreSQL (max_connections=100)
process.env.DB_POOL_MAX = '4';
