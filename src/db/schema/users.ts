import { pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { citext } from './types';

export const appRole = pgEnum('app_role', ['user', 'store_manager', 'super_admin']);
export type AppRole = (typeof appRole.enumValues)[number];

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: citext('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: appRole('role').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
