import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgEnum, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { projects } from './projects';
import { users } from './users';

export const taskChangeOp = pgEnum('task_change_op', ['create', 'update', 'link', 'unlink', 'remove']);
export type TaskChangeOp = (typeof taskChangeOp.enumValues)[number];

/** Task fields a change can carry: the new values in `data`, the old ones in `prev`. */
export type TaskChangeFields = Partial<{
  name: string;
  startDate: string;
  endDate: string;
  status: 'not_started' | 'in_progress' | 'done';
}>;

/**
 * The project's task changelog: one row per effective change, written in the
 * same transaction as the change itself. Every row of one batch shares the
 * version the batch bumped projects.graph_version to, so versions are
 * contiguous per project and "everything after version N" is a range scan on
 * the primary key.
 *
 * Tasks are named by their number, not their internal id: the public code is
 * derived from (project_id, number), so reading the log needs no join.
 *
 * Rows are trimmed after a retention period (TaskChangesPruner), always as a
 * whole prefix of versions per project, so a client further behind than the
 * oldest kept version is told to reload the snapshot instead of missing a gap.
 */
export const taskChanges = pgTable(
  'task_changes',
  {
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    version: integer('version').notNull(),
    // Order within the batch.
    seq: integer('seq').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    op: taskChangeOp('op').notNull(),
    taskNumber: integer('task_number').notNull(),
    // Only for link / unlink: the task it waits on (or stopped waiting on).
    dependsOnNumber: integer('depends_on_number'),
    // create: every field; update: only the fields that changed.
    data: jsonb('data').$type<TaskChangeFields>(),
    // update only: the values those fields had before.
    prev: jsonb('prev').$type<TaskChangeFields>(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.version, t.seq] }),
    // Trimming finds old rows by age.
    index('task_changes_created_at_idx').on(t.createdAt),
    check('task_changes_link_target', sql`(${t.op} in ('link', 'unlink')) = (${t.dependsOnNumber} is not null)`),
  ],
);

export type TaskChange = typeof taskChanges.$inferSelect;
