import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '../auth/current-user';
import { sql } from 'drizzle-orm';
import { DB, Db } from '../db/db.module';

@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async check() {
    await this.db.execute(sql`select 1`);
    return { status: 'ok' };
  }
}
