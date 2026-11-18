import { ApiPropertyOptional } from '@nestjs/swagger';
import { and, asc, desc, type AnyColumn, type SQL, sql } from 'drizzle-orm';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PageQueryDto } from '../projects/dto/project.dto';

/** Paging + free-text search + sort direction. Routes subclass it to add their own filters and a `sort` key. */
export class ListQueryDto extends PageQueryDto {
  /** Case-insensitive substring search. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order: 'asc' | 'desc' = 'asc';
}

type Sortable = AnyColumn | SQL | SQL.Aliased;

/**
 * What one list route allows, declared once. Clients only ever reach the
 * filters, search columns and sort keys named here, never arbitrary columns.
 */
export interface ListSpec<Q extends ListQueryDto & { sort: string }> {
  /** Columns `q` matches against (ILIKE '%q%', any of them). */
  search?: AnyColumn[];
  /** One entry per optional query param: turns its value into a condition. */
  filters?: { [K in Exclude<keyof Q, keyof ListQueryDto | 'sort'>]?: (value: NonNullable<Q[K]>) => SQL };
  sorts: Record<Q['sort'], Sortable>;
  /** Unique column appended to the order so pages never overlap or skip rows. */
  tiebreak: AnyColumn;
}

export function defineList<Q extends ListQueryDto & { sort: string }>(spec: ListSpec<Q>) {
  return {
    /** The WHERE and ORDER BY for this query; `base` holds conditions that always apply (scope, soft delete). */
    build(query: Q, base: (SQL | undefined)[] = []) {
      const where = [...base];
      for (const [key, toSql] of Object.entries(spec.filters ?? {}) as [keyof Q, (v: unknown) => SQL][]) {
        const value = query[key];
        if (value !== undefined && value !== null) where.push(toSql(value));
      }
      if (query.q && spec.search?.length) {
        const pattern = `%${escapeLike(query.q)}%`;
        where.push(sql`(${sql.join(
          spec.search.map((c) => sql`${c} ilike ${pattern}`),
          sql` or `,
        )})`);
      }
      const direction = query.order === 'desc' ? desc : asc;
      return {
        where: and(...where),
        orderBy: [direction(spec.sorts[query.sort as Q['sort']]), direction(spec.tiebreak)],
      };
    },
  };
}

export function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, '\\$&');
}

/** Select alongside the row fields to get the total match count in the same query. */
export const totalCount = sql<number>`count(*) over ()::int`;

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Strips the `total` column off each row and wraps them as a page. */
export function toPage<R extends { total: number }, T>(
  rows: R[],
  query: PageQueryDto,
  map: (row: Omit<R, 'total'>) => T,
): Page<T> {
  return {
    items: rows.map(({ total: _, ...r }) => map(r)),
    total: rows[0]?.total ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}
