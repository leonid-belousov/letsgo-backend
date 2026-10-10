/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '(src|test)/.*\\.(spec|e2e-spec)\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  testEnvironment: 'node',
  testTimeout: 60000, // real-PostgreSQL suites run in parallel workers
  maxWorkers: 8,
  setupFiles: ['<rootDir>/test/setup-env.ts'],
};
