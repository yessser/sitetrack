import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type SQL, and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AuthUser } from '../auth/current-user';
import { DB, type Db } from '../db/db.module';
import { taskDependencies, tasks } from '../db/schema';
import type { ProjectAccess } from '../projects/project-access.service';
import type {
  AddDependencyDto,
  CreateTaskDto,
  TaskAction,
  TaskDetailDto,
  TaskLinkDto,
  TaskListQueryDto,
  TaskPageDto,
  TaskStatusValue,
  UpdateTaskDto,
} from './dto/task.dto';
import { TaskChangesService } from './task-changes.service';
import { taskNumberIn } from './task-code';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/*
 * The invariant everything below leans on:
 *
 *   A task that has left Not started has every task it waits on Done.
 *
 * Every write goes through TaskChangesService.apply, which checks the final
 * state of the batch against it (task-batch.ts) under a per-project lock.
 * Because it holds, "every task it waits on, directly or indirectly" can be
 * checked one step away: if a direct dependency is Done, everything behind it
 * is too. So Blocked and the allowed actions are plain EXISTS over direct
 * links (index lookups), never a walk of the graph.
 *
 * This service keeps the reads and the single-task routes, which are
 * one-item batches.
 */

const dep = alias(tasks, 'dep');

// Late is derived on every read so it always reflects today's date.
const isLate = sql<boolean>`(
  (${tasks.status} <> 'done' and ${tasks.endDate} < current_date)
  or (${tasks.status} = 'not_started' and ${tasks.startDate} < current_date)
)`;

// Drizzle prints columns unqualified in single-table selects, which would
// bind to the subquery's own tables, so the outer row is named explicitly.
const outer = { id: sql.raw('"tasks"."id"'), projectId: sql.raw('"tasks"."project_id"') };

// Direct links only, thanks to the invariant above.
const isBlocked = sql<boolean>`(${tasks.status} <> 'done' and exists (
  select 1 from ${taskDependencies} d join ${tasks} p on p.id = d.depends_on_id
  where d.project_id = ${outer.projectId} and d.task_id = ${outer.id} and p.status <> 'done'
))`;

const dependentsCount = sql<number>`(
  select count(*)::int from ${taskDependencies} d
  where d.project_id = ${outer.projectId} and d.depends_on_id = ${outer.id}
)`;

const taskFields = {
  id: tasks.id,
  code: tasks.code,
  name: tasks.name,
  startDate: tasks.startDate,
  endDate: tasks.endDate,
  status: tasks.status,
  isLate,
  isBlocked,
  dependentsCount,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
};

// What the action routes do. A batch can set any status except back to not_started.
const TRANSITIONS: Record<TaskAction, { from: TaskStatusValue; to: TaskStatusValue }> = {
  start: { from: 'not_started', to: 'in_progress' },
  done: { from: 'in_progress', to: 'done' },
  reopen: { from: 'done', to: 'in_progress' },
};

const SORT_COLUMNS = {
  code: tasks.number,
  name: tasks.name,
  startDate: tasks.startDate,
  endDate: tasks.endDate,
  dependents: dependentsCount,
};

/** Tasks of one project. Every method takes a ProjectAccess, so the membership gate has already run. */
@Injectable()
export class TasksService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly changes: TaskChangesService,
  ) {}

  async create(user: AuthUser, access: ProjectAccess, dto: CreateTaskDto): Promise<TaskDetailDto> {
    const { name, startDate, endDate } = dto;
    const { refs } = await this.changes.apply(user, access.projectId, {
      create: [{ ref: 'new', name, startDate, endDate }],
      link: (dto.dependsOn ?? []).map((d) => ({ task: 'new', dependsOn: d })),
    });
    return this.get(access, refs.new);
  }

  async list(access: ProjectAccess, query: TaskListQueryDto): Promise<TaskPageDto> {
    const filters: (SQL | undefined)[] = [eq(tasks.projectId, access.projectId), isNull(tasks.deletedAt)];
    if (query.status) filters.push(eq(tasks.status, query.status));
    if (query.late !== undefined) filters.push(query.late ? isLate : sql`not ${isLate}`);
    if (query.blocked !== undefined) filters.push(query.blocked ? isBlocked : sql`not ${isBlocked}`);
    // Overlap with the requested range, so a task spanning it is included.
    if (query.from) filters.push(sql`${tasks.endDate} >= ${query.from}`);
    if (query.to) filters.push(sql`${tasks.startDate} <= ${query.to}`);
    if (query.q) {
      const pattern = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
      filters.push(sql`(${tasks.name} ilike ${pattern} or ${tasks.code} ilike ${pattern})`);
    }

    const direction = query.order === 'desc' ? desc : asc;
    const rows = await this.db
      .select({ ...taskFields, total: sql<number>`count(*) over ()::int` })
      .from(tasks)
      .where(and(...filters))
      .orderBy(direction(SORT_COLUMNS[query.sort]), direction(tasks.number))
      .limit(query.limit)
      .offset(query.offset);

    // Direct dependency IDs only for the page, in one query.
    const dependsOn = await this.directDependsOn(
      access.projectId,
      rows.map((r) => r.id),
    );
    return {
      items: rows.map(({ total: _, id, ...r }) => ({
        ...r,
        dependsOn: dependsOn.get(id) ?? [],
      })),
      total: rows[0]?.total ?? 0,
      limit: query.limit,
      offset: query.offset,
    };
  }

  async get(access: ProjectAccess, code: string): Promise<TaskDetailDto> {
    return this.detail(this.db, (await this.resolve(this.db, access.projectId, code)).id);
  }

  async update(user: AuthUser, access: ProjectAccess, code: string, dto: UpdateTaskDto): Promise<TaskDetailDto> {
    await this.resolve(this.db, access.projectId, code);
    await this.changes.apply(user, access.projectId, { update: [{ task: code, set: dto }] });
    return this.get(access, code);
  }

  /**
   * Soft delete: the number stays taken, so the ID is never handed out again.
   * Its links go with it, so tasks waiting on it stop waiting.
   */
  async remove(user: AuthUser, access: ProjectAccess, code: string) {
    await this.resolve(this.db, access.projectId, code);
    await this.changes.apply(user, access.projectId, { remove: [code] });
  }

  /**
   * A status action. Strict: the task must be in the action's "from" status
   * when the batch runs, so of two people pressing Start at once only one
   * wins, and a stale screen can't skip a step.
   */
  async transition(user: AuthUser, access: ProjectAccess, code: string, action: TaskAction): Promise<TaskDetailDto> {
    await this.resolve(this.db, access.projectId, code);
    const { from, to } = TRANSITIONS[action];
    await this.changes.apply(user, access.projectId, {
      update: [{ task: code, set: { status: to }, expect: { status: from }, strict: true }],
    });
    return this.get(access, code);
  }

  /** "code waits on dto.dependsOn". */
  async addDependency(
    user: AuthUser,
    access: ProjectAccess,
    code: string,
    dto: AddDependencyDto,
  ): Promise<TaskDetailDto> {
    await this.resolve(this.db, access.projectId, code);
    await this.changes.apply(user, access.projectId, {
      link: [{ task: code, dependsOn: dto.dependsOn, strict: true }],
    });
    return this.get(access, code);
  }

  async removeDependency(user: AuthUser, access: ProjectAccess, code: string, dependsOnCode: string) {
    await this.resolve(this.db, access.projectId, code);
    await this.resolve(this.db, access.projectId, dependsOnCode).catch(() => {
      throw new NotFoundException('Dependency not found');
    });
    await this.changes.apply(user, access.projectId, {
      unlink: [{ task: code, dependsOn: dependsOnCode, strict: true }],
    });
  }

  // Codes are exact match (same as project codes), scoped to the project the
  // caller already passed the gate for, so a task from another project 404s
  // without a query.
  private async resolve(db: Executor, projectId: number, code: string) {
    const number = taskNumberIn(projectId, code);
    if (number === null) throw new NotFoundException('Task not found');
    const [row] = await db
      .select({
        id: tasks.id,
        status: tasks.status,
        startDate: tasks.startDate,
        endDate: tasks.endDate,
      })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.number, number), isNull(tasks.deletedAt)));
    if (!row) throw new NotFoundException('Task not found');
    return { ...row, code };
  }


  private async directDependsOn(projectId: number, ids: number[]) {
    const byTask = new Map<number, string[]>();
    if (ids.length === 0) return byTask;
    const rows = await this.db
      .select({ taskId: taskDependencies.taskId, code: dep.code })
      .from(taskDependencies)
      .innerJoin(dep, eq(dep.id, taskDependencies.dependsOnId))
      .where(and(eq(taskDependencies.projectId, projectId), inArray(taskDependencies.taskId, ids)))
      .orderBy(dep.number);
    for (const r of rows) {
      const list = byTask.get(r.taskId);
      if (list) list.push(r.code);
      else byTask.set(r.taskId, [r.code]);
    }
    return byTask;
  }

  /**
   * The task with everything it waits on and everything waiting on it, each
   * with the fewest steps away.
   *
   * One query loads the project's links (an index-only range scan on the
   * primary key; a few thousand pairs for the largest project) and a BFS in
   * each direction gives shortest distances in O(tasks + links). Doing it as
   * a recursive CTE that tracks depth would revisit a task once per distinct
   * path length, which blows up on dense graphs.
   */
  private async detail(db: Executor, id: number): Promise<TaskDetailDto> {
    const [{ id: _, ...task }] = await db
      .select({ ...taskFields, projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, id));
    const { projectId, ...fields } = task;

    const edges = await db
      .select({
        taskId: taskDependencies.taskId,
        dependsOnId: taskDependencies.dependsOnId,
      })
      .from(taskDependencies)
      .where(eq(taskDependencies.projectId, projectId));
    const up = new Map<number, number[]>(); // task -> what it depends on
    const down = new Map<number, number[]>(); // task -> what depends on it
    for (const e of edges) {
      push(up, e.taskId, e.dependsOnId);
      push(down, e.dependsOnId, e.taskId);
    }
    const upSteps = bfs(id, up);
    const downSteps = bfs(id, down);

    const reached = [...new Set([...upSteps.keys(), ...downSteps.keys()])];
    const info = reached.length
      ? await db
          .select({
            id: tasks.id,
            number: tasks.number,
            code: tasks.code,
            name: tasks.name,
            status: tasks.status,
          })
          .from(tasks)
          .where(inArray(tasks.id, reached))
      : [];
    const byId = new Map(info.map((t) => [t.id, t]));
    const links = (steps: Map<number, number>): TaskLinkDto[] =>
      [...steps]
        .map(([tid, s]) => ({ ...byId.get(tid)!, steps: s }))
        .sort((a, b) => a.steps - b.steps || a.number - b.number)
        .map(({ code, name, status, steps: s }) => ({
          code,
          name,
          status,
          steps: s,
        }));

    const waitsOn = links(upSteps);
    const waitedBy = links(downSteps);
    const direct = (l: TaskLinkDto[]) => l.filter((t) => t.steps === 1);

    return {
      ...fields,
      // Already in ID order: same steps, then by number.
      dependsOn: direct(waitsOn).map((t) => t.code),
      allowedActions: (Object.keys(TRANSITIONS) as TaskAction[]).filter((a) => {
        if (TRANSITIONS[a].from !== fields.status) return false;
        if (a === 'start') return !fields.isBlocked;
        if (a === 'reopen') return direct(waitedBy).every((t) => t.status === 'not_started');
        return true;
      }),
      waitsOn,
      waitedBy,
    };
  }

}

function push(map: Map<number, number[]>, key: number, value: number) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Shortest number of steps from `start` to every task reachable through `adj`. */
function bfs(start: number, adj: Map<number, number[]>): Map<number, number> {
  const steps = new Map<number, number>();
  let frontier = [start];
  for (let depth = 1; frontier.length; depth++) {
    const next: number[] = [];
    for (const node of frontier) {
      for (const n of adj.get(node) ?? []) {
        if (n === start || steps.has(n)) continue;
        steps.set(n, depth);
        next.push(n);
      }
    }
    frontier = next;
  }
  return steps;
}
