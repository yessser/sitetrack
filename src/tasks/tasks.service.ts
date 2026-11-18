import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type SQL, and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AuthUser } from '../auth/current-user';
import { DB, type Db } from '../db/db.module';
import { projects, taskDependencies, tasks } from '../db/schema';
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
import { taskNumberIn } from './task-code';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/*
 * The invariant everything below leans on:
 *
 *   A task that has left Not started has every task it waits on Done.
 *
 * Start requires it, Reopen refuses to break it, and a new dependency on a
 * started task is only accepted when the task it points at is Done. Because
 * it holds, "every task it waits on, directly or indirectly" can be checked
 * one step away: if a direct dependency is Done, everything behind it is too.
 * So Blocked, the Start guard and the Reopen guard are all plain EXISTS over
 * direct links (index lookups), never a walk of the graph.
 *
 * Writes that could break it (link, unlink, start, reopen, done, remove) take
 * a per-project advisory lock, so check-then-write can't interleave: e.g.
 * Start B and Reopen A, or A→B and B→A passing the cycle check side by side.
 */
const TASK_GRAPH_LOCK = 1;

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

// The only status changes allowed. Anything else is rejected with 409.
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
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(user: AuthUser, access: ProjectAccess, dto: CreateTaskDto): Promise<TaskDetailDto> {
    this.assertDates(dto.startDate, dto.endDate);
    const dependsOn = dto.dependsOn ?? [];
    const id = await this.db.transaction(async (tx) => {
      // A brand new task is Not started and nothing waits on it yet, so its
      // links can't form a cycle or break the invariant. The lock is still
      // needed so a task it points at can't be removed underneath it.
      if (dependsOn.length) await this.lockGraph(tx, access.projectId);
      const targets = await this.resolveMany(tx, access.projectId, dependsOn);

      // Row lock on the project: concurrent creates here wait for each other,
      // so no two tasks get the same number. A rollback also rolls the counter
      // back, so a number is only ever consumed by a task that exists(ed).
      const [{ number }] = await tx
        .update(projects)
        .set({ nextTaskNumber: sql`${projects.nextTaskNumber} + 1` })
        .where(eq(projects.id, access.projectId))
        .returning({ number: sql<number>`${projects.nextTaskNumber} - 1` });
      const [task] = await tx
        .insert(tasks)
        .values({
          projectId: access.projectId,
          number,
          name: dto.name,
          startDate: dto.startDate,
          endDate: dto.endDate,
          createdBy: user.userId,
        })
        .returning({ id: tasks.id });
      if (targets.length) {
        await tx.insert(taskDependencies).values(
          targets.map((t) => ({
            projectId: access.projectId,
            taskId: task.id,
            dependsOnId: t.id,
          })),
        );
      }
      return task.id;
    });
    return this.detail(this.db, id);
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

  async update(access: ProjectAccess, code: string, dto: UpdateTaskDto): Promise<TaskDetailDto> {
    const current = await this.resolve(this.db, access.projectId, code);
    this.assertDates(dto.startDate ?? current.startDate, dto.endDate ?? current.endDate);
    await this.db
      .update(tasks)
      .set({ ...dto, updatedAt: new Date() })
      .where(eq(tasks.id, current.id));
    return this.detail(this.db, current.id);
  }

  /**
   * Soft delete: the number stays taken, so the ID is never handed out again.
   * Its links go with it, so tasks waiting on it stop waiting.
   */
  async remove(access: ProjectAccess, code: string) {
    await this.db.transaction(async (tx) => {
      await this.lockGraph(tx, access.projectId);
      const { id } = await this.resolve(tx, access.projectId, code);
      await tx.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, id));
      await tx
        .delete(taskDependencies)
        .where(
          and(
            eq(taskDependencies.projectId, access.projectId),
            or(eq(taskDependencies.taskId, id), eq(taskDependencies.dependsOnId, id)),
          ),
        );
    });
  }

  /**
   * Applies a status action. The UPDATE is conditional on the expected
   * current status, so two people pressing Start at once can't both win and
   * a stale screen can't skip a step. Then the dependency guard runs; failing
   * it throws, which rolls the UPDATE back.
   */
  async transition(access: ProjectAccess, code: string, action: TaskAction): Promise<TaskDetailDto> {
    const id = await this.db.transaction(async (tx) => {
      await this.lockGraph(tx, access.projectId);
      const task = await this.resolve(tx, access.projectId, code);
      const { from, to } = TRANSITIONS[action];
      const updated = await tx
        .update(tasks)
        .set({ status: to, updatedAt: new Date() })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, from)))
        .returning({ id: tasks.id });
      if (updated.length === 0) throw new ConflictException(`Cannot ${action} a task that is ${task.status}`);

      if (action === 'start' && (await this.waitsOnUnfinished(tx, access.projectId, task.id))) {
        throw new ConflictException('Cannot start a task that waits on tasks that are not done');
      }
      if (action === 'reopen' && (await this.hasStartedDependents(tx, access.projectId, task.id))) {
        throw new ConflictException('Cannot reopen a task while a task that waits on it has started');
      }
      return task.id;
    });
    return this.detail(this.db, id);
  }

  /** "code waits on dto.dependsOn". */
  async addDependency(access: ProjectAccess, code: string, dto: AddDependencyDto): Promise<TaskDetailDto> {
    const id = await this.db.transaction(async (tx) => {
      await this.lockGraph(tx, access.projectId);
      const task = await this.resolve(tx, access.projectId, code);
      const [target] = await this.resolveMany(tx, access.projectId, [dto.dependsOn]);
      if (target.id === task.id) throw new BadRequestException('A task cannot depend on itself');
      if (task.status !== 'not_started' && target.status !== 'done') {
        throw new ConflictException('A task that has started can only depend on tasks that are done');
      }
      if (await this.waitsOn(tx, access.projectId, target.id, task.id)) {
        throw new ConflictException(`${target.code} already waits on ${task.code}; this would create a cycle`);
      }
      const inserted = await tx
        .insert(taskDependencies)
        .values({
          projectId: access.projectId,
          taskId: task.id,
          dependsOnId: target.id,
        })
        .onConflictDoNothing()
        .returning({ taskId: taskDependencies.taskId });
      if (inserted.length === 0) throw new ConflictException(`${task.code} already depends on ${target.code}`);
      return task.id;
    });
    return this.detail(this.db, id);
  }

  // Removing a link can't break the invariant or create a cycle, so no lock.
  async removeDependency(access: ProjectAccess, code: string, dependsOnCode: string) {
    const task = await this.resolve(this.db, access.projectId, code);
    const dependsOnNumber = taskNumberIn(access.projectId, dependsOnCode);
    if (dependsOnNumber === null) throw new NotFoundException('Dependency not found');
    const deleted = await this.db
      .delete(taskDependencies)
      .where(
        and(
          eq(taskDependencies.projectId, access.projectId),
          eq(taskDependencies.taskId, task.id),
          sql`${taskDependencies.dependsOnId} = (
            select id from ${tasks} where project_id = ${access.projectId} and number = ${dependsOnNumber}
          )`,
        ),
      )
      .returning({ taskId: taskDependencies.taskId });
    if (deleted.length === 0) throw new NotFoundException('Dependency not found');
  }

  // Transaction-scoped: released on commit or rollback. Keyed per project, so
  // other projects never wait on each other.
  private async lockGraph(tx: Tx, projectId: number) {
    await tx.execute(sql`select pg_advisory_xact_lock(${TASK_GRAPH_LOCK}::int, ${projectId}::int)`);
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

  // Tasks named in a request body: unknown ones (including other projects'
  // tasks) are a 400, in the order given.
  private async resolveMany(db: Executor, projectId: number, codes: string[]) {
    if (codes.length === 0) return [];
    const numbers = codes.map((c) => taskNumberIn(projectId, c)).filter((n) => n !== null);
    const rows = numbers.length
      ? await db
          .select({ id: tasks.id, code: tasks.code, status: tasks.status })
          .from(tasks)
          .where(and(eq(tasks.projectId, projectId), inArray(tasks.number, numbers), isNull(tasks.deletedAt)))
      : [];
    const byCode = new Map(rows.map((r) => [r.code, r]));
    const missing = codes.filter((c) => !byCode.has(c));
    if (missing.length) throw new BadRequestException(`Unknown task: ${missing.join(', ')}`);
    return codes.map((c) => byCode.get(c)!);
  }

  private async waitsOnUnfinished(db: Executor, projectId: number, id: number) {
    const [row] = await db
      .select({ id: dep.id })
      .from(taskDependencies)
      .innerJoin(dep, eq(dep.id, taskDependencies.dependsOnId))
      .where(
        and(eq(taskDependencies.projectId, projectId), eq(taskDependencies.taskId, id), sql`${dep.status} <> 'done'`),
      )
      .limit(1);
    return !!row;
  }

  private async hasStartedDependents(db: Executor, projectId: number, id: number) {
    const [row] = await db
      .select({ id: dep.id })
      .from(taskDependencies)
      .innerJoin(dep, eq(dep.id, taskDependencies.taskId))
      .where(
        and(
          eq(taskDependencies.projectId, projectId),
          eq(taskDependencies.dependsOnId, id),
          sql`${dep.status} <> 'not_started'`,
        ),
      )
      .limit(1);
    return !!row;
  }

  /**
   * Does `from` wait on `to`, directly or indirectly? UNION (not UNION ALL)
   * drops tasks already reached, so each task is expanded once: O(reachable
   * links), and the walk stops at the first hit because the outer EXISTS pulls
   * rows from the recursive CTE lazily.
   */
  private async waitsOn(db: Executor, projectId: number, from: number, to: number) {
    const result = await db.execute<{ found: boolean }>(sql`
      with recursive reach(id) as (
        select depends_on_id from ${taskDependencies} where project_id = ${projectId} and task_id = ${from}
        union
        select d.depends_on_id from ${taskDependencies} d join reach r on d.task_id = r.id
        where d.project_id = ${projectId}
      )
      select exists (select 1 from reach where id = ${to}) as found
    `);
    return result.rows[0].found;
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

  private assertDates(start: string, end: string) {
    if (end < start) throw new BadRequestException('endDate must be on or after startDate');
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
