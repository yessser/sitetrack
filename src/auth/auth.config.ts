export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';
// The refresh cookie is only ever sent to /auth/refresh and /auth/logout.
export const REFRESH_COOKIE_PATH = '/auth';

export const cookieSecure = () => process.env.COOKIE_SECURE !== 'false';
