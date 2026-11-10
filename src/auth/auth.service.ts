import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DB, type Db } from '../db/db.module';
import { sessions, users } from '../db/schema';
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS } from './auth.config';
import type { AuthUser } from './current-user';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class AuthService {
  // Verified against when the email is unknown, so a failed login takes
  // the same time whether or not the account exists.
  private readonly dummyHash = argon2.hash(randomBytes(16).toString('hex'));

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const passwordHash = await argon2.hash(dto.password);
    try {
      const [user] = await this.db
        .insert(users)
        .values({ name: dto.name, email: dto.email, passwordHash, role: dto.role })
        .returning({ id: users.id, name: users.name, email: users.email, role: users.role, createdAt: users.createdAt });
      return user;
    } catch (err) {
      if ((err as { cause?: { code?: string } }).cause?.code === '23505') {
        throw new ConflictException('Email is already registered');
      }
      throw err;
    }
  }

  async login(dto: LoginDto): Promise<IssuedTokens> {
    const [user] = await this.db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, dto.email));

    const valid = await argon2.verify(user?.passwordHash ?? (await this.dummyHash), dto.password);
    if (!user || !valid) throw new UnauthorizedException('Invalid email or password');

    const secret = randomBytes(32).toString('base64url');
    const [session] = await this.db
      .insert(sessions)
      .values({ userId: user.id, refreshTokenHash: sha256(secret), expiresAt: this.refreshExpiry() })
      .returning({ id: sessions.id });

    return this.issue(session.id, secret);
  }

  async refresh(refreshToken: string | undefined): Promise<IssuedTokens> {
    const parsed = this.parseRefreshToken(refreshToken);
    if (!parsed) throw new UnauthorizedException();

    const [session] = await this.db
      .select({ refreshTokenHash: sessions.refreshTokenHash })
      .from(sessions)
      .where(and(eq(sessions.id, parsed.sessionId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())));
    if (!session || !this.hashMatches(parsed.secret, session.refreshTokenHash)) {
      throw new UnauthorizedException();
    }

    // Rotate: the old refresh token stops working. The hash condition makes
    // two concurrent refreshes with the same token produce one winner.
    const secret = randomBytes(32).toString('base64url');
    const rotated = await this.db
      .update(sessions)
      .set({ refreshTokenHash: sha256(secret), expiresAt: this.refreshExpiry(), lastUsedAt: new Date() })
      .where(and(eq(sessions.id, parsed.sessionId), eq(sessions.refreshTokenHash, session.refreshTokenHash)))
      .returning({ id: sessions.id });
    if (rotated.length === 0) throw new UnauthorizedException();

    return this.issue(parsed.sessionId, secret);
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    const parsed = this.parseRefreshToken(refreshToken);
    if (!parsed) return;
    const [session] = await this.db
      .select({ refreshTokenHash: sessions.refreshTokenHash })
      .from(sessions)
      .where(eq(sessions.id, parsed.sessionId));
    if (!session || !this.hashMatches(parsed.secret, session.refreshTokenHash)) return;
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, parsed.sessionId), isNull(sessions.revokedAt)));
  }

  async resolveSession(sessionId: string): Promise<AuthUser | null> {
    const [row] = await this.db
      .select({ userId: users.id, role: users.role })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())));
    return row ? { ...row, sessionId } : null;
  }

  private async issue(sessionId: string, secret: string): Promise<IssuedTokens> {
    const accessToken = await this.jwt.signAsync({ sid: sessionId }, { expiresIn: ACCESS_TOKEN_TTL_SECONDS });
    return { accessToken, refreshToken: `${sessionId}.${secret}` };
  }

  // Refresh token format: "<sessionId>.<secret>". Only sha256(secret) is stored.
  private parseRefreshToken(token: string | undefined) {
    const match = token?.match(/^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/);
    return match ? { sessionId: match[1], secret: match[2] } : null;
  }

  private hashMatches(secret: string, storedHash: string) {
    return timingSafeEqual(Buffer.from(sha256(secret)), Buffer.from(storedHash));
  }

  private refreshExpiry() {
    return new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
  }
}
