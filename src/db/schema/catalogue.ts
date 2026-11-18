import { sql } from 'drizzle-orm';
import { type AnyPgColumn, index, integer, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { citext } from './types';

// Shared label list for how quantities are counted. No conversions between units.
export const units = pgTable('units', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  symbol: citext('symbol').notNull().unique(),
});

// Nestable to any depth. Deleting one is a real delete; the FKs below (restrict)
// refuse it while subcategories or materials still point at it.
export const categories = pgTable(
  'categories',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    name: citext('name').notNull(),
    parentId: integer('parent_id').references((): AnyPgColumn => categories.id),
  },
  (t) => [
    // Unique among siblings; NULLS NOT DISTINCT makes it hold for top-level ones too.
    unique('categories_parent_name_unique').on(t.parentId, t.name).nullsNotDistinct(),
    index('categories_parent_id_idx').on(t.parentId),
  ],
);

// Catalogue entries. Names are deliberately not unique (variants like 25 kg vs
// 50 kg bags look alike); removed materials are soft-deleted so stores and
// deliveries can still show them.
export const materials = pgTable(
  'materials',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    name: text('name').notNull(),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id),
    unitId: integer('unit_id')
      .notNull()
      .references(() => units.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // Default list order.
    index('materials_name_idx').on(t.name, t.id).where(sql`${t.deletedAt} is null`),
    // Substring search (?q=) with a leading wildcard.
    index('materials_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),
    index('materials_category_id_idx').on(t.categoryId),
    index('materials_unit_id_idx').on(t.unitId),
  ],
);

export type Material = typeof materials.$inferSelect;
