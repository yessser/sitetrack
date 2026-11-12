import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/current-user';
import { sql } from 'drizzle-orm';
import { DB, Db } from '../db/db.module';
import { HealthDto } from './health.dto';

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async check(): Promise<HealthDto> {
    await this.db.execute(sql`select 1`);
    return { status: 'ok' };
  }
}
