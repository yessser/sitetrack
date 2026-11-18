import type { TaskChangeFields } from '../db/schema';
import { taskCode, taskNumberIn } from './task-code';

/*
 * Plans a batch of task changes against the project's current graph, in
 * memory and without touching the database: either the full list of problems,
 * or exactly what to write and what to log. TaskChangesService loads the graph
 * under the project's lock, calls this, and writes the plan.
 *
 * Checking the final state as a whole (rather than item by item) is what lets
 * a batch reorder freely: "finish A, then start B that waits on A" is fine in
 * one batch, whatever order the items come in.
 *
 * The invariant it keeps (see tasks.service.ts):
 *   A task that has left Not started has every task it waits on Done.
 */

export const TASK_CHANGE_OPS = ['create', 'update', 'link', 'unlink', 'remove'] as const;
export type TaskChangeOpValue = (typeof TASK_CHANGE_OPS)[number];
type Status = NonNullable<TaskChangeFields['status']>;
const FIELDS = ['name', 'startDate', 'endDate', 'status'] as const;

export interface TaskState {
  id: number | null; // null for tasks created by this batch
  number: number;
  name: string;
  startDate: string;
  endDate: string;
  status: Status;
}

export interface Graph {
  projectId: number;
  nextTaskNumber: number;
  tasks: Map<number, TaskState>; // live tasks by number
  links: Set<string>; // linkKey(task, dependsOn), by number
}

/**
 * `strict` is for the single-action routes, which keep their old meaning:
 * an expected value must match exactly (not "already at the target"), a link
 * must not exist yet, an unlink must hit an existing link.
 */
export interface TaskBatch {
  create?: { ref: string; name: string; startDate: string; endDate: string }[];
  update?: { task: string; set: TaskChangeFields; expect?: TaskChangeFields; strict?: boolean }[];
  link?: { task: string; dependsOn: string; strict?: boolean }[];
  unlink?: { task: string; dependsOn: string; strict?: boolean }[];
  remove?: string[];
}

export interface BatchError {
  at: string;
  task?: string;
  code: BatchErrorCode;
  message: string;
}

export const BATCH_ERROR_STATUS = {
  too_large: 400,
  unknown_task: 400,
  duplicate_ref: 400,
  duplicate_item: 400,
  removed_task: 400,
  self_link: 400,
  invalid_dates: 400,
  conflict: 409,
  status_back: 409,
  cycle: 409,
  blocked: 409,
  started_dependents: 409,
  started_link: 409,
  link_exists: 409,
  link_missing: 404,
} as const;
export type BatchErrorCode = keyof typeof BATCH_ERROR_STATUS;

export interface PlannedChange {
  op: TaskChangeOpValue;
  taskNumber: number;
  dependsOnNumber: number | null;
  data: TaskChangeFields | null;
  prev: TaskChangeFields | null;
}

export interface Plan {
  errors: BatchError[];
  refs: Record<string, number>;
  creates: TaskState[];
  updates: TaskState[]; // existing tasks, final values
  removes: TaskState[];
  linksAdded: [number, number][];
  linksRemoved: [number, number][];
  changes: PlannedChange[];
}

export const linkKey = (task: number, dependsOn: number) => `${task}>${dependsOn}`;
const unKey = (key: string) => key.split('>').map(Number) as [number, number];

export function countItems(batch: TaskBatch) {
  return (
    (batch.create?.length ?? 0) +
    (batch.update?.length ?? 0) +
    (batch.link?.length ?? 0) +
    (batch.unlink?.length ?? 0) +
    (batch.remove?.length ?? 0)
  );
}

export function planBatch(graph: Graph, batch: TaskBatch): Plan {
  const errors: BatchError[] = [];
  const fail = (at: string, code: BatchErrorCode, message: string, task?: string) =>
    errors.push({ at, code, message, ...(task !== undefined && { task }) });

  const orig = graph.tasks;
  const work = new Map<number, TaskState>();
  for (const [n, t] of orig) work.set(n, { ...t });
  const links = new Set(graph.links);

  const refs: Record<string, number> = {};
  const refOf = new Map<number, string>();
  const label = (n: number) => refOf.get(n) ?? taskCode(graph.projectId, n);

  // Item that last touched a task's fields: dates and invariant errors point at it.
  const fieldsItem = new Map<number, string>();
  const statusItem = new Map<number, string>();
  const linkItem = new Map<string, string>();
  const removed = new Map<number, string>();

  // 1. Creates: numbers are handed out in order from the project's counter.
  const creates: TaskState[] = [];
  let next = graph.nextTaskNumber;
  batch.create?.forEach((c, i) => {
    const at = `create[${i}]`;
    if (c.ref in refs) return fail(at, 'duplicate_ref', `ref "${c.ref}" is used twice`, c.ref);
    const task: TaskState = {
      id: null,
      number: next++,
      name: c.name,
      startDate: c.startDate,
      endDate: c.endDate,
      status: 'not_started',
    };
    refs[c.ref] = task.number;
    refOf.set(task.number, c.ref);
    work.set(task.number, task);
    creates.push(task);
    fieldsItem.set(task.number, at);
  });

  // A task named by ID or by the ref of a create; null (with an error) if neither.
  const resolve = (at: string, name: string): number | null => {
    if (Object.hasOwn(refs, name)) return refs[name];
    const n = taskNumberIn(graph.projectId, name);
    if (n !== null && orig.has(n)) return n;
    fail(at, 'unknown_task', `Unknown task: ${name}`, name);
    return null;
  };
  const isRemoved = (at: string, name: string, n: number) => {
    if (!removed.has(n)) return false;
    fail(at, 'removed_task', `${name} is removed by ${removed.get(n)} of this batch`, name);
    return true;
  };

  // 2. Removes, first, so the items below can refuse to touch a removed task.
  batch.remove?.forEach((name, i) => {
    const at = `remove[${i}]`;
    const n = resolve(at, name);
    if (n === null) return;
    if (refOf.has(n)) return fail(at, 'removed_task', `${name} is created by this batch; leave it out instead`, name);
    if (removed.has(n)) return fail(at, 'duplicate_item', `${name} is removed twice`, name);
    removed.set(n, at);
  });

  // 3. Updates.
  const updated = new Set<number>();
  batch.update?.forEach((u, i) => {
    const at = `update[${i}]`;
    const n = resolve(at, u.task);
    if (n === null || isRemoved(at, u.task, n)) return;
    if (updated.has(n)) return fail(at, 'duplicate_item', `${u.task} is updated twice; merge the items`, u.task);
    updated.add(n);

    const before = orig.get(n); // undefined for a task created by this batch
    const task = work.get(n)!;
    if (before && u.expect) {
      for (const f of FIELDS) {
        const expected = u.expect[f];
        if (expected === undefined || before[f] === expected) continue;
        // Someone else already made the same change: nothing to fight over.
        if (!u.strict && before[f] === u.set[f]) continue;
        fail(at, 'conflict', `${label(n)}: ${f} is now "${before[f]}", not "${expected}"`, u.task);
      }
    }
    if (u.set.status === 'not_started' && task.status !== 'not_started') {
      fail(at, 'status_back', `${label(n)} has started and cannot go back to not_started`, u.task);
    }
    for (const f of FIELDS) {
      const value = u.set[f];
      if (value === undefined) continue;
      (task as Record<typeof f, string>)[f] = value;
    }
    fieldsItem.set(n, at);
    if (u.set.status !== undefined) statusItem.set(n, at);
  });

  // 4. Unlinks, then links. Both are set operations: no-ops unless strict.
  const pairs = new Set<string>();
  const pair = (at: string, item: { task: string; dependsOn: string }) => {
    const a = resolve(at, item.task);
    const b = resolve(at, item.dependsOn);
    if (a === null || b === null) return null;
    if (isRemoved(at, item.task, a) || isRemoved(at, item.dependsOn, b)) return null;
    if (a === b) {
      fail(at, 'self_link', 'A task cannot depend on itself', item.task);
      return null;
    }
    const key = linkKey(a, b);
    if (pairs.has(key)) {
      fail(at, 'duplicate_item', `${item.task} → ${item.dependsOn} appears twice in the batch`, item.task);
      return null;
    }
    pairs.add(key);
    return key;
  };
  const linksRemoved: [number, number][] = [];
  batch.unlink?.forEach((l, i) => {
    const at = `unlink[${i}]`;
    const key = pair(at, l);
    if (key === null) return;
    if (links.delete(key)) linksRemoved.push(unKey(key));
    else if (l.strict) fail(at, 'link_missing', `${l.task} does not depend on ${l.dependsOn}`, l.task);
  });
  const linksAdded: [number, number][] = [];
  batch.link?.forEach((l, i) => {
    const at = `link[${i}]`;
    const key = pair(at, l);
    if (key === null) return;
    if (links.has(key)) {
      if (l.strict) fail(at, 'link_exists', `${l.task} already depends on ${l.dependsOn}`, l.task);
      return;
    }
    links.add(key);
    linkItem.set(key, at);
    linksAdded.push(unKey(key));
  });

  // 5. Removed tasks take their links with them.
  for (const key of links) {
    const [a, b] = unKey(key);
    if (removed.has(a) || removed.has(b)) links.delete(key);
  }
  for (const n of removed.keys()) work.delete(n);

  // 6. Dates of every task the batch wrote fields of.
  for (const [n, at] of fieldsItem) {
    const t = work.get(n);
    if (t && t.endDate < t.startDate) {
      fail(at, 'invalid_dates', `${label(n)}: endDate must be on or after startDate`, refOf.get(n) ?? label(n));
    }
  }

  // 7. The invariant, on every link the batch could have broken: a new link,
  //    or a link whose ends changed status. One error per item at fault.
  const broken = new Map<string, { at: string; code: BatchErrorCode; task: number; others: number[] }>();
  for (const key of links) {
    const [a, b] = unKey(key);
    const ta = work.get(a)!;
    const tb = work.get(b)!;
    if (ta.status === 'not_started' || tb.status === 'done') continue;
    const blame: [string | undefined, BatchErrorCode, number, number] | null = linkItem.has(key)
      ? [linkItem.get(key), 'started_link', a, b]
      : statusItem.has(a)
        ? [statusItem.get(a), 'blocked', a, b]
        : statusItem.has(b)
          ? [statusItem.get(b), 'started_dependents', b, a]
          : null; // was already broken before this batch: not ours to report
    if (!blame) continue;
    const [at, code, task, other] = blame;
    const id = `${at}|${code}`;
    const entry = broken.get(id) ?? { at: at!, code, task, others: [] };
    entry.others.push(other);
    broken.set(id, entry);
  }
  for (const { at, code, task, others } of broken.values()) {
    const list = others.map(label).join(', ');
    const t = label(task);
    const message =
      code === 'started_link'
        ? `${t} has started, so it can only depend on tasks that are done (${list} is not)`
        : code === 'blocked'
          ? `${t} cannot be ${work.get(task)!.status} while it waits on tasks that are not done: ${list}`
          : `${t} cannot leave done while tasks that wait on it have started: ${list}`;
    fail(at, code, message, t);
  }

  // 8. Cycles, only possible if a link was added.
  if (linksAdded.length) {
    const cycle = findCycle(work, links);
    if (cycle) {
      // A cycle always goes through at least one new link: blame the first,
      // and start the path there, so it reads "the link you added, then the
      // way back".
      const keys = cycle.map((n, i) => linkKey(n, cycle[(i + 1) % cycle.length]));
      const i = keys.findIndex((k) => linkItem.has(k));
      const at = linkItem.get(keys[i])!;
      const from = [...cycle.slice(i), ...cycle.slice(0, i)];
      const path = [...from, from[0]].map(label).join(' → ');
      fail(at, 'cycle', `This would create a cycle: ${path}`);
    }
  }

  // 9. The diff, in log order: create, update, unlink, link, remove.
  const updates: TaskState[] = [];
  const changes: PlannedChange[] = [];
  const change = (op: TaskChangeOpValue, taskNumber: number, rest: Partial<PlannedChange> = {}) =>
    changes.push({ op, taskNumber, dependsOnNumber: null, data: null, prev: null, ...rest });
  for (const t of creates) {
    const { id: _, number, ...data } = t;
    change('create', number, { data });
  }
  for (const n of updated) {
    const before = orig.get(n);
    if (!before) continue; // a created task: its fields are in its create
    const after = work.get(n)!;
    const data: TaskChangeFields = {};
    const prev: TaskChangeFields = {};
    for (const f of FIELDS) {
      if (after[f] === before[f]) continue;
      (data as Record<string, string>)[f] = after[f];
      (prev as Record<string, string>)[f] = before[f];
    }
    if (Object.keys(data).length === 0) continue;
    updates.push(after);
    change('update', n, { data, prev });
  }
  for (const [a, b] of linksRemoved) change('unlink', a, { dependsOnNumber: b });
  for (const [a, b] of linksAdded) change('link', a, { dependsOnNumber: b });
  const removes = [...removed.keys()].map((n) => orig.get(n)!);
  for (const t of removes) change('remove', t.number);

  return { errors, refs, creates, updates, removes, linksAdded, linksRemoved, changes };
}

/**
 * A cycle among `links` (task -> what it waits on), as the list of tasks on
 * it in waiting order, or null. Kahn's algorithm peels off every task that
 * nothing waits on; each task left over still has a leftover task waiting on
 * it, so walking backwards along those links must come round to a repeat.
 */
function findCycle(tasks: Map<number, TaskState>, links: Set<string>): number[] | null {
  const out = new Map<number, number[]>(); // task -> what it waits on
  const waiters = new Map<number, number[]>(); // task -> what waits on it
  const indegree = new Map<number, number>();
  for (const n of tasks.keys()) indegree.set(n, 0);
  for (const key of links) {
    const [a, b] = unKey(key);
    push(out, a, b);
    push(waiters, b, a);
    indegree.set(b, indegree.get(b)! + 1);
  }
  const queue = [...indegree].filter(([, d]) => d === 0).map(([n]) => n);
  while (queue.length) {
    const n = queue.pop()!;
    indegree.delete(n);
    for (const m of out.get(n) ?? []) {
      const d = indegree.get(m)! - 1;
      indegree.set(m, d);
      if (d === 0) queue.push(m);
    }
  }
  if (indegree.size === 0) return null;

  const seen = new Map<number, number>();
  const path: number[] = [];
  let n = indegree.keys().next().value!;
  while (!seen.has(n)) {
    seen.set(n, path.length);
    path.push(n);
    n = waiters.get(n)!.find((m) => indegree.has(m))!;
  }
  // The walk went from waited-on to waiter; flip it to read "waits on".
  return path.slice(seen.get(n)).reverse();
}

function push(map: Map<number, number[]>, key: number, value: number) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
