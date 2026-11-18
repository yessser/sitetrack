import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module';
import { FK_VIOLATION, pgError, UNIQUE_VIOLATION } from '../db/pg-error';
import { categories } from '../db/schema';
import type { CategoryDto, CreateCategoryDto, UpdateCategoryDto } from './dto/catalogue.dto';

const categoryFields = { id: categories.id, name: categories.name, parentId: categories.parentId };

// Serialises moves, so two concurrent moves (A under B, B under A) can't
// each pass the cycle check and together form a loop. Moves are rare.
const TREE_LOCK = sql`select pg_advisory_xact_lock(2, 0)`;

@Injectable()
export class CategoriesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The whole tree as a flat list; the client nests it by parentId. */
  list(): Promise<CategoryDto[]> {
    return this.db.select(categoryFields).from(categories).orderBy(asc(categories.name), asc(categories.id));
  }

  async create(dto: CreateCategoryDto): Promise<CategoryDto> {
    const [row] = await this.db
      .insert(categories)
      .values({ name: dto.name, parentId: dto.parentId ?? null })
      .returning(categoryFields)
      .catch(mapWriteError);
    return row;
  }

  async update(id: number, dto: UpdateCategoryDto): Promise<CategoryDto> {
    if (dto.name === undefined && dto.parentId === undefined) {
      const [row] = await this.db.select(categoryFields).from(categories).where(eq(categories.id, id));
      if (!row) throw new NotFoundException('Category not found');
      return row;
    }
    return this.db.transaction(async (tx) => {
      if (dto.parentId !== undefined) {
        await tx.execute(TREE_LOCK);
        if (dto.parentId !== null && (await this.isInSubtree(tx, dto.parentId, id))) {
          throw new ConflictException('A category cannot be moved inside itself or its own subcategories');
        }
      }
      const [row] = await tx
        .update(categories)
        .set({ name: dto.name, parentId: dto.parentId })
        .where(eq(categories.id, id))
        .returning(categoryFields)
        .catch(mapWriteError);
      if (!row) throw new NotFoundException('Category not found');
      return row;
    });
  }

  /** Hard delete; the FKs refuse it while subcategories or materials (removed ones included) point at it. */
  async remove(id: number): Promise<void> {
    const deleted = await this.db
      .delete(categories)
      .where(eq(categories.id, id))
      .returning({ id: categories.id })
      .catch((err) => {
        if (pgError(err).code === FK_VIOLATION) {
          throw new ConflictException('Category still has subcategories or materials');
        }
        throw err;
      });
    if (deleted.length === 0) throw new NotFoundException('Category not found');
  }

  /** Whether `candidate` is `root` or one of its descendants. */
  private async isInSubtree(tx: Pick<Db, 'execute'>, candidate: number, root: number): Promise<boolean> {
    const { rows } = await tx.execute<{ found: boolean }>(sql`
      with recursive sub(id) as (
        select ${root}::int
        union
        select c.id from categories c join sub on c.parent_id = sub.id
      )
      select exists (select 1 from sub where id = ${candidate}) as found`);
    return rows[0].found;
  }
}

function mapWriteError(err: unknown): never {
  const { code } = pgError(err);
  if (code === UNIQUE_VIOLATION) throw new ConflictException('A category with this name already exists here');
  if (code === FK_VIOLATION) throw new NotFoundException('Parent category not found');
  throw err;
}
