import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { FastifyRequest } from 'fastify';
import { ACCESS_COOKIE } from './auth.config';
import { AuthService } from './auth.service';
import { IS_PUBLIC } from './current-user';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) {
      return true;
    }
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: unknown }>();
    const token = req.cookies?.[ACCESS_COOKIE];
    if (!token) throw new UnauthorizedException();

    let sid: string;
    try {
      ({ sid } = await this.jwt.verifyAsync<{ sid: string }>(token));
    } catch {
      throw new UnauthorizedException();
    }

    // Session and role are read from the DB on every request, so logout
    // and role changes apply on the very next request.
    const user = await this.auth.resolveSession(sid);
    if (!user) throw new UnauthorizedException();
    req.user = user;
    return true;
  }
}
