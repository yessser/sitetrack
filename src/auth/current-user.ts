import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AppRole } from '../db/schema';

export interface AuthUser {
  userId: string;
  sessionId: string;
  role: AppRole;
}

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);
