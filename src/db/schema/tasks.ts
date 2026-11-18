import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { projects } from './projects';
import { users } from './users';

export const taskStatus = pgEnum('task_status', ['not_started', 'in_progress', 'done']);
export type TaskStatus = (typeof taskStatus.enumValues)[number];

export const tasks = pgTable(
  'tasks',
  {
    // Internal key for joins and future dependency edges; never exposed.
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    // Counts up within the project, handed out from projects.next_task_number.
    number: integer('number').notNull(),
    // PRJ-0042-T-0137. Built from project_id because a project's code is
    // itself derived from its id, so no join is needed to search by ID.
    code: text('code')
      .notNull()
      .generatedAlwaysAs(
        sql`'PRJ-' || lpad(project_id::text, greatest(4, length(project_id::text)), '0') || '-T-' || lpad(number::text, greatest(4, length(number::text)), '0')`,
      ),
    name: text('name').notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull(),
    status: taskStatus('status').notNull().default('not_started'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // Safety net behind the counter; also the index for "tasks of a project".
    unique('tasks_project_number_unique').on(t.projectId, t.number),
    // Target of the dependency foreign keys, so the database itself refuses a
    // link between tasks of different projects.
    unique('tasks_project_id_unique').on(t.projectId, t.id),
    check('tasks_dates_check', sql`${t.endDate} >= ${t.startDate}`),
  ],
);

export type Task = typeof tasks.$inferSelect;

/**
 * "task waits for dependsOn". Only direct links are stored: the transitive
 * closure is never materialized (a 3,000-task chain would be ~4.5M rows and
 * every edit would rewrite it). Reachability is walked on demand instead.
 *
 * Rows are hard-deleted when either task is removed, so a removed task never
 * keeps blocking anything and every row points at a live task.
 */
export const taskDependencies = pgTable(
  'task_dependencies',
  {
    projectId: integer('project_id').notNull(),
    taskId: integer('task_id').notNull(),
    dependsOnId: integer('depends_on_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Project first: serves "the whole graph of a project" and "what does this
    // task wait on" with one index.
    primaryKey({ columns: [t.projectId, t.taskId, t.dependsOnId] }),
    // "What waits on this task": dependents count, reopen guard, waited-by walk.
    index('task_dependencies_depends_on_idx').on(t.projectId, t.dependsOnId),
    foreignKey({ columns: [t.projectId, t.taskId], foreignColumns: [tasks.projectId, tasks.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.projectId, t.dependsOnId], foreignColumns: [tasks.projectId, tasks.id] }).onDelete(
      'cascade',
    ),
    check('task_dependencies_not_self', sql`${t.taskId} <> ${t.dependsOnId}`),
  ],
);
