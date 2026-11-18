/** Postgres error code and constraint of a failed query; drizzle wraps the pg error in `cause`. */
export function pgError(err: unknown): { code?: string; constraint?: string } {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  return e.cause ?? e;
}

export const UNIQUE_VIOLATION = '23505';
export const FK_VIOLATION = '23503';
