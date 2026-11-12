import { inject } from 'vitest';

// The database comes from global-setup (a throwaway container by default).
process.env.DATABASE_URL = inject('databaseUrl');
process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789-0123456789';
process.env.COOKIE_SECURE = 'false';
