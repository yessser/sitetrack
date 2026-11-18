import { ForbiddenException } from '@nestjs/common';
import type { AppRole } from '../db/schema';
import type { AuthUser } from './current-user';

/** Throws 403 unless the caller's app role is one of `roles`. Role is read fresh per request by AuthGuard. */
export function requireRole(user: AuthUser, ...roles: AppRole[]) {
  if (!roles.includes(user.role)) throw new ForbiddenException('Your app role cannot do this');
}

/** Who may change the materials catalogue (units, categories, materials). */
export const CATALOGUE_WRITERS: AppRole[] = ['store_manager', 'super_admin'];
