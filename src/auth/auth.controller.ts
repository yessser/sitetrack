import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ACCESS_COOKIE,
  ACCESS_TOKEN_TTL_SECONDS,
  cookieSecure,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_SECONDS,
} from './auth.config';
import { AuthService, type IssuedTokens } from './auth.service';
import { Public } from './current-user';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

// Brute-force protection for the credential endpoints.
const CREDENTIALS_THROTTLE = { default: { ttl: 60_000, limit: 10 } };

@Public()
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @Throttle(CREDENTIALS_THROTTLE)
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Post('login')
  @Throttle(CREDENTIALS_THROTTLE)
  @HttpCode(204)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: FastifyReply) {
    this.setCookies(res, await this.auth.login(dto));
  }

  @Post('refresh')
  @HttpCode(204)
  async refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    try {
      this.setCookies(res, await this.auth.refresh(req.cookies[REFRESH_COOKIE]));
    } catch (err) {
      this.clearCookies(res);
      throw err;
    }
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    await this.auth.logout(req.cookies[REFRESH_COOKIE]);
    this.clearCookies(res);
  }

  private setCookies(res: FastifyReply, tokens: IssuedTokens) {
    const base = { httpOnly: true, secure: cookieSecure() } as const;
    res.setCookie(ACCESS_COOKIE, tokens.accessToken, {
      ...base,
      sameSite: 'lax',
      path: '/',
      maxAge: ACCESS_TOKEN_TTL_SECONDS,
    });
    res.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
      ...base,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      maxAge: REFRESH_TOKEN_TTL_SECONDS,
    });
  }

  private clearCookies(res: FastifyReply) {
    res.clearCookie(ACCESS_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
  }
}
