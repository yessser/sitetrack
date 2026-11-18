import { HttpException, Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { BadRequestException, GoneException } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { AuthUser } from '../auth/current-user';
import { DB, type Db } from '../db/db.module';
import { projects, taskChanges, taskDependencies, tasks } from '../db/schema';
import {
  MAX_BATCH_ITEMS,
  type TaskBatchResultDto,
  type TaskChangeDto,
  type TaskChangesPageDto,
  type TaskSnapshotDto,
} from './dto/task-changes.dto';
import {
  BATCH_ERROR_STATUS,
  type BatchError,
  type Graph,
  type PlannedChange,
  type TaskBatch,
  countItems,
  linkKey,
  planBatch,
} from './task-batch';
import { taskCode } from './task-code';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// Shared with nothing else: one advisory lock key space for the task graph.
const TASK_GRAPH_LOCK = 1;
// Rows per INSERT, well under Postgres' 65,535 bind parameters.
const CHUNK = 1000;

const isLate = sql<boolean>`(
  (${tasks.status} <> 'done' and ${tasks.endDate} < current_date)
  or (${tasks.status} = 'not_started' and ${tasks.startDate} < current_date)
)`;
const isBlocked = sql<boolean>`(${tasks.status} <> 'done' and exists (
  select 1 from ${taskDependencies} d join ${tasks} p on p.id = d.depends_on_id
  where d.project_id = "tasks"."project_id" and d.task_id = "tasks"."id" and p.status <> 'done'
))`;

/** A rejected batch: every problem found, at once. */
export class TaskBatchRejected extends HttpException {
  constructor(readonly errors: BatchError[]) {
    const statuses = errors.map((e) => BATCH_ERROR_STATUS[e.code]);
    const status = statuses.includes(409) ? 409 : statuses.includes(400) ? 400 : 404;
    super(
      {
        statusCode: status,
        message: errors.length === 1 ? errors[0].message : `The batch has ${errors.length} problems`,
        errors,
      },
      status,
    );
  }
}

/**
 * Every write to a project's tasks and links goes through apply(): one
 * transaction holding the project's graph lock, so batches of one project
 * run one after another and each sees the result of the last. Reads never
 * take the lock.
 */
@Injectable()
export class TaskChangesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async apply(
    user: AuthUser,
    projectId: number,
    batch: TaskBatch,
    opts: { dryRun?: boolean } = {},
  ): Promise<TaskBatchResultDto> {
    if (countItems(batch) > MAX_BATCH_ITEMS) {
      throw new TaskBatchRejected([
        { at: 'batch', code: 'too_large', message: `A batch holds at most ${MAX_BATCH_ITEMS} items` },
      ]);
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${TASK_GRAPH_LOCK}::int, ${projectId}::int)`);
      const { graph, version, ids } = await this.load(tx, projectId);
      const plan = planBatch(graph, batch);
      if (plan.errors.length) throw new TaskBatchRejected(plan.errors);

      const code = (n: number) => taskCode(projectId, n);
      const refs = Object.fromEntries(Object.entries(plan.refs).map(([ref, n]) => [ref, code(n)]));
      if (plan.changes.length === 0) return { version, refs, changes: [] };

      const next = version + 1;
      const at = new Date();
      const result = {
        version: opts.dryRun ? version : next,
        refs,
        changes: plan.changes.map((c) => toDto(projectId, { ...c, version: next, userId: user.userId, createdAt: at })),
      };
      if (opts.dryRun) return result;

      await tx
        .update(projects)
        .set({ graphVersion: next, nextTaskNumber: graph.nextTaskNumber + plan.creates.length })
        .where(eq(projects.id, projectId));

      for (const part of chunks(plan.creates)) {
        const inserted = await tx
          .insert(tasks)
          .values(
            part.map((t) => ({
              projectId,
              number: t.number,
              name: t.name,
              startDate: t.startDate,
              endDate: t.endDate,
              status: t.status,
              createdBy: user.userId,
            })),
          )
          .returning({ id: tasks.id, number: tasks.number });
        for (const r of inserted) ids.set(r.number, r.id);
      }

      if (plan.updates.length) {
        const rows = plan.updates.map(({ number, ...t }) => ({ ...t, id: ids.get(number)! }));
        await tx.execute(sql`
          update ${tasks} t set name = v.name, start_date = v."startDate", end_date = v."endDate",
            status = v.status, updated_at = now()
          from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
            as v(id int, name text, "startDate" date, "endDate" date, status task_status)
          where t.id = v.id
        `);
      }

      const pairs = (list: [number, number][]) =>
        JSON.stringify(list.map(([a, b]) => ({ task_id: ids.get(a)!, depends_on_id: ids.get(b)! })));
      if (plan.linksRemoved.length) {
        await tx.execute(sql`
          delete from ${taskDependencies} d
          using jsonb_to_recordset(${pairs(plan.linksRemoved)}::jsonb) as v(task_id int, depends_on_id int)
          where d.project_id = ${projectId} and d.task_id = v.task_id and d.depends_on_id = v.depends_on_id
        `);
      }

      if (plan.removes.length) {
        const removed = plan.removes.map((t) => t.id!);
        await tx.update(tasks).set({ deletedAt: at }).where(inArray(tasks.id, removed));
        await tx
          .delete(taskDependencies)
          .where(
            and(
              eq(taskDependencies.projectId, projectId),
              or(inArray(taskDependencies.taskId, removed), inArray(taskDependencies.dependsOnId, removed)),
            ),
          );
      }

      for (const part of chunks(plan.linksAdded)) {
        await tx
          .insert(taskDependencies)
          .values(part.map(([a, b]) => ({ projectId, taskId: ids.get(a)!, dependsOnId: ids.get(b)! })));
      }

      const log = plan.changes.map((c, seq) => ({ ...c, projectId, version: next, seq, userId: user.userId, createdAt: at }));
      for (const part of chunks(log)) await tx.insert(taskChanges).values(part);

      return result;
    });
  }

  /**
   * Every live task and link, plus the version they are at. Read in one
   * snapshot, so the version matches exactly what is returned.
   */
  async snapshot(projectId: number): Promise<TaskSnapshotDto> {
    return this.db.transaction(
      async (tx) => {
        const [{ version }] = await tx
          .select({ version: projects.graphVersion })
          .from(projects)
          .where(eq(projects.id, projectId));
        const rows = await tx
          .select({
            id: tasks.id,
            code: tasks.code,
            name: tasks.name,
            startDate: tasks.startDate,
            endDate: tasks.endDate,
            status: tasks.status,
            isLate,
            isBlocked,
            updatedAt: tasks.updatedAt,
          })
          .from(tasks)
          .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt)))
          .orderBy(asc(tasks.number));
        const edges = await tx
          .select({ taskId: taskDependencies.taskId, dependsOnId: taskDependencies.dependsOnId })
          .from(taskDependencies)
          .where(eq(taskDependencies.projectId, projectId));
        const codeOf = new Map(rows.map((r) => [r.id, r.code]));
        return {
          version,
          tasks: rows.map(({ id: _, ...t }) => t),
          links: edges.map((e) => ({ task: codeOf.get(e.taskId)!, dependsOn: codeOf.get(e.dependsOnId)! })),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  /**
   * The changelog after `since`, oldest first, whole batches only. A client
   * further behind than the trimmed log reaches gets 410 and reloads the snapshot.
   */
  async since(projectId: number, since: number): Promise<TaskChangesPageDto> {
    return this.db.transaction(
      async (tx) => {
        const [{ version }] = await tx
          .select({ version: projects.graphVersion })
          .from(projects)
          .where(eq(projects.id, projectId));
        if (since > version) throw new BadRequestException(`since is ahead of the current version (${version})`);
        if (since === version) return { version, hasMore: false, changes: [] };

        // A batch is at most MAX_BATCH_ITEMS changes, so a page this size
        // always holds at least one whole batch.
        const rows = await tx
          .select()
          .from(taskChanges)
          .where(and(eq(taskChanges.projectId, projectId), gt(taskChanges.version, since)))
          .orderBy(asc(taskChanges.version), asc(taskChanges.seq))
          .limit(MAX_BATCH_ITEMS + 1);
        if (rows[0]?.version !== since + 1) {
          throw new GoneException('Changes that old have been trimmed; reload the snapshot');
        }
        let page = rows;
        let hasMore = false;
        if (rows.length > MAX_BATCH_ITEMS) {
          const cut = rows[MAX_BATCH_ITEMS].version; // possibly incomplete: leave it for the next page
          page = rows.filter((r) => r.version < cut);
          hasMore = true;
        }
        return {
          version: hasMore ? page[page.length - 1].version : version,
          hasMore,
          changes: page.map((r) => toDto(projectId, r)),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  /** Removes changelog entries older than `days`, as a whole prefix of versions per project. */
  async trim(days: number): Promise<number> {
    const result = await this.db.execute(sql`
      delete from ${taskChanges} c
      using (
        select project_id, max(version) as version from ${taskChanges}
        where created_at < now() - ${days}::float8 * interval '1 day'
        group by project_id
      ) old
      where c.project_id = old.project_id and c.version <= old.version
    `);
    return result.rowCount ?? 0;
  }

  private async load(tx: Tx, projectId: number) {
    const [project] = await tx
      .select({ nextTaskNumber: projects.nextTaskNumber, version: projects.graphVersion })
      .from(projects)
      .where(eq(projects.id, projectId));
    const rows = await tx
      .select({
        id: tasks.id,
        number: tasks.number,
        name: tasks.name,
        startDate: tasks.startDate,
        endDate: tasks.endDate,
        status: tasks.status,
      })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNull(tasks.deletedAt)));
    const edges = await tx
      .select({ taskId: taskDependencies.taskId, dependsOnId: taskDependencies.dependsOnId })
      .from(taskDependencies)
      .where(eq(taskDependencies.projectId, projectId));

    const numberOf = new Map(rows.map((r) => [r.id, r.number]));
    const ids = new Map(rows.map((r) => [r.number, r.id]));
    const graph: Graph = {
      projectId,
      nextTaskNumber: project.nextTaskNumber,
      tasks: new Map(rows.map((r) => [r.number, r])),
      links: new Set(edges.map((e) => linkKey(numberOf.get(e.taskId)!, numberOf.get(e.dependsOnId)!))),
    };
    return { graph, version: project.version, ids };
  }
}

function toDto(
  projectId: number,
  c: PlannedChange & { version: number; userId: string; createdAt: Date },
): TaskChangeDto {
  return {
    version: c.version,
    op: c.op,
    task: taskCode(projectId, c.taskNumber),
    ...(c.dependsOnNumber !== null && { dependsOn: taskCode(projectId, c.dependsOnNumber) }),
    ...(c.data && { data: c.data }),
    ...(c.prev && { prev: c.prev }),
    by: c.userId,
    at: c.createdAt,
  };
}

function* chunks<T>(list: T[]) {
  for (let i = 0; i < list.length; i += CHUNK) yield list.slice(i, i + CHUNK);
}

/**
 * Trims the changelog every hour. TASK_CHANGES_RETENTION_DAYS (default 30)
 * sets how long entries are kept; 0 keeps them forever.
 */
@Injectable()
export class TaskChangesTrimmer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TaskChangesTrimmer.name);
  private timer?: NodeJS.Timeout;
  readonly retentionDays = Number(process.env.TASK_CHANGES_RETENTION_DAYS ?? 30);

  constructor(private readonly changes: TaskChangesService) {}

  onApplicationBootstrap() {
    if (!(this.retentionDays > 0)) return;
    this.timer = setInterval(() => void this.run(), 60 * 60 * 1000);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async run() {
    try {
      const n = await this.changes.trim(this.retentionDays);
      if (n) this.logger.log(`Trimmed ${n} task changes older than ${this.retentionDays} days`);
    } catch (err) {
      this.logger.error('Trimming task changes failed', err as Error);
    }
  }
}
