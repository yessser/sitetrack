// Tests run against their own database on the same postgres as docker compose.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  `postgres://sitetrack:sitetrack@localhost:${process.env.DB_PORT ?? 5432}/sitetrack_test`;

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789-0123456789';
process.env.COOKIE_SECURE = 'false';
