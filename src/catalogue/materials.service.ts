import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { defineList, type Page, toPage, totalCount } from '../common/list';
import { DB, type Db } from '../db/db.module';
import { FK_VIOLATION, pgError } from '../db/pg-error';
import { categories, materials, units } from '../db/schema';
import type {
  CreateMaterialDto,
  MaterialDto,
  MaterialListQueryDto,
  UpdateMaterialDto,
} from './dto/catalogue.dto';

const materialFields = {
  id: materials.id,
  name: materials.name,
  category: { id: categories.id, name: categories.name, parentId: categories.parentId },
  unit: { id: units.id, name: units.name, symbol: units.symbol },
  createdAt: materials.createdAt,
  updatedAt: materials.updatedAt,
};

const materialList = defineList<MaterialListQueryDto>({
  search: [materials.name],
  filters: {
    // The category and everything under it. The category table is small, so the walk is cheap.
    category: (id) => sql`${materials.categoryId} in (
      with recursive sub(id) as (
        select ${id}::int
        union
        select c.id from categories c join sub on c.parent_id = sub.id
      )
      select id from sub)`,
  },
  sorts: { name: materials.name },
  tiebreak: materials.id,
});

const live = isNull(materials.deletedAt);

@Injectable()
export class MaterialsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(query: MaterialListQueryDto): Promise<Page<MaterialDto>> {
    const { where, orderBy } = materialList.build(query, [live]);
    const rows = await this.db
      .select({ ...materialFields, total: totalCount })
      .from(materials)
      .innerJoin(categories, eq(categories.id, materials.categoryId))
      .innerJoin(units, eq(units.id, materials.unitId))
      .where(where)
      .orderBy(...orderBy)
      .limit(query.limit)
      .offset(query.offset);
    return toPage(rows, query, (r) => r);
  }

  async get(id: number): Promise<MaterialDto> {
    const [row] = await this.db
      .select(materialFields)
      .from(materials)
      .innerJoin(categories, eq(categories.id, materials.categoryId))
      .innerJoin(units, eq(units.id, materials.unitId))
      .where(and(eq(materials.id, id), live));
    if (!row) throw new NotFoundException('Material not found');
    return row;
  }

  async create(dto: CreateMaterialDto): Promise<MaterialDto> {
    const [{ id }] = await this.db
      .insert(materials)
      .values({ name: dto.name, categoryId: dto.categoryId, unitId: dto.unitId })
      .returning({ id: materials.id })
      .catch(mapReferenceError);
    return this.get(id);
  }

  async update(id: number, dto: UpdateMaterialDto): Promise<MaterialDto> {
    const updated = await this.db
      .update(materials)
      .set({ name: dto.name, categoryId: dto.categoryId, unitId: dto.unitId, updatedAt: sql`now()` })
      .where(and(eq(materials.id, id), live))
      .returning({ id: materials.id })
      .catch(mapReferenceError);
    if (updated.length === 0) throw new NotFoundException('Material not found');
    return this.get(id);
  }

  /** Soft delete: the row stays for stores and deliveries that already mention it. */
  async remove(id: number): Promise<void> {
    const removed = await this.db
      .update(materials)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(materials.id, id), live))
      .returning({ id: materials.id });
    if (removed.length === 0) throw new NotFoundException('Material not found');
  }
}

function mapReferenceError(err: unknown): never {
  const { code, constraint } = pgError(err);
  if (code === FK_VIOLATION) {
    throw new NotFoundException(constraint?.includes('unit') ? 'Unit not found' : 'Category not found');
  }
  throw err;
}
