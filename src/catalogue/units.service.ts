import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { FK_VIOLATION, pgError, UNIQUE_VIOLATION } from '../db/pg-error';
import { units } from '../db/schema';
import type { CreateUnitDto, UnitDto, UpdateUnitDto } from './dto/catalogue.dto';

const unitFields = { id: units.id, name: units.name, symbol: units.symbol };

@Injectable()
export class UnitsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  list(): Promise<UnitDto[]> {
    return this.db.select(unitFields).from(units).orderBy(asc(units.name), asc(units.id));
  }

  async create(dto: CreateUnitDto): Promise<UnitDto> {
    const [row] = await this.db
      .insert(units)
      .values({ name: dto.name, symbol: dto.symbol })
      .returning(unitFields)
      .catch(conflictOnDuplicateSymbol);
    return row;
  }

  async update(id: number, dto: UpdateUnitDto): Promise<UnitDto> {
    if (dto.name === undefined && dto.symbol === undefined) return this.get(id);
    const [row] = await this.db
      .update(units)
      .set({ name: dto.name, symbol: dto.symbol })
      .where(eq(units.id, id))
      .returning(unitFields)
      .catch(conflictOnDuplicateSymbol);
    if (!row) throw new NotFoundException('Unit not found');
    return row;
  }

  /** Hard delete; the materials FK refuses it while any material (removed ones included) uses the unit. */
  async remove(id: number): Promise<void> {
    const deleted = await this.db
      .delete(units)
      .where(eq(units.id, id))
      .returning({ id: units.id })
      .catch((err) => {
        if (pgError(err).code === FK_VIOLATION) throw new ConflictException('Unit is used by materials');
        throw err;
      });
    if (deleted.length === 0) throw new NotFoundException('Unit not found');
  }

  private async get(id: number): Promise<UnitDto> {
    const [row] = await this.db.select(unitFields).from(units).where(eq(units.id, id));
    if (!row) throw new NotFoundException('Unit not found');
    return row;
  }
}

function conflictOnDuplicateSymbol(err: unknown): never {
  if (pgError(err).code === UNIQUE_VIOLATION) throw new ConflictException('A unit with this symbol already exists');
  throw err;
}
