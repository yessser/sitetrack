import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { users } from '../db/schema';

@Injectable()
export class UsersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async profile(userId: string) {
    const [user] = await this.db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) throw new NotFoundException();
    return user;
  }
}
