import { sql } from 'drizzle-orm';
import { check, date, index, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export const projects = pgTable(
  'projects',
  {
    // Sequence-backed: unique under concurrent inserts and never reused.
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    code: text('code')
      .notNull()
      .unique()
      .generatedAlwaysAs(sql`'PRJ-' || lpad(id::text, greatest(4, length(id::text)), '0')`),
    name: text('name').notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull(),
    // Per-project task counter. Bumped with UPDATE ... RETURNING, which locks
    // the project row so concurrent task creates in one project queue up and
    // each gets its own number. Never decremented, so numbers are not reused.
    nextTaskNumber: integer('next_task_number').notNull().default(1),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [check('projects_dates_check', sql`${t.endDate} >= ${t.startDate}`)],
);

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    // Null for regular members. Earlier = more senior: an admin can only
    // demote or remove admins appointed after them.
    adminSince: timestamp('admin_since', { withTimezone: true }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] }), index('project_members_user_id_idx').on(t.userId)],
);

export type Project = typeof projects.$inferSelect;
