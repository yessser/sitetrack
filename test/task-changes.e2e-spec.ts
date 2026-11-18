import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { TaskChangesService } from '../src/tasks/task-changes.service';
import { addMember, createTestApp, pool, resetDb, signUp } from './helpers';

describe('task changes', () => {
  let app: NestFastifyApplication;
  const project = { name: 'Riverside Tower', startDate: '2026-01-01', endDate: '2099-12-31' };
  const url = '/projects/PRJ-0001/tasks';
  const future = { startDate: '2099-01-01', endDate: '2099-02-01' };
  const t = (n: number) => `PRJ-0001-T-${String(n).padStart(4, '0')}`;
  type Client = Awaited<ReturnType<typeof signUp>>;

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(resetDb);
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  async function setup() {
    const admin = await signUp(app, 'user', 'Admin');
    await admin.post('/projects', project);
    return admin;
  }
  const batch = (c: Client, body: object, query = '') => c.post(`${url}/changes${query}`, body);
  const snapshot = async (c: Client) => (await c.get(`${url}/snapshot`)).body;
  const codes = (errors: { code: string }[]) => errors.map((e) => e.code).sort();

  describe('batches', () => {
    it('creates tasks and links them by ref, in one version, and answers with the real IDs', async () => {
      const admin = await setup();
      const res = await batch(admin, {
        create: [
          { ref: 'dig', name: 'Excavation', ...future },
          { ref: 'pour', name: 'Pour slab', ...future },
        ],
        link: [{ task: 'pour', dependsOn: 'dig' }],
      });
      expect(res.status).toBe(200);
      expect(res.body.version).toBe(1);
      expect(res.body.refs).toEqual({ dig: t(1), pour: t(2) });
      expect(res.body.changes.map((c: { op: string }) => c.op)).toEqual(['create', 'create', 'link']);
      expect(res.body.changes[2]).toMatchObject({ version: 1, task: t(2), dependsOn: t(1), by: admin.id });

      const g = await snapshot(admin);
      expect(g.version).toBe(1);
      expect(g.tasks.map((x: { code: string; isBlocked: boolean }) => [x.code, x.isBlocked])).toEqual([
        [t(1), false],
        [t(2), true],
      ]);
      expect(g.links).toEqual([{ task: t(2), dependsOn: t(1) }]);
    });

    it('checks the final state, so items can come in any order', async () => {
      const admin = await setup();
      await batch(admin, {
        create: [
          { ref: 'a', name: 'A', ...future },
          { ref: 'b', name: 'B', ...future },
        ],
        link: [{ task: 'b', dependsOn: 'a' }],
      });
      // Start B (waits on A) listed before finishing A.
      const res = await batch(admin, {
        update: [
          { task: t(2), set: { status: 'in_progress' } },
          { task: t(1), set: { status: 'done' } },
        ],
      });
      expect(res.status).toBe(200);
      expect((await snapshot(admin)).tasks.map((x: { status: string }) => x.status)).toEqual(['done', 'in_progress']);
    });

    it('saves nothing when any item is wrong, and reports every problem at once', async () => {
      const admin = await setup();
      await batch(admin, { create: [{ ref: 'a', name: 'A', ...future }] });
      const res = await batch(admin, {
        create: [
          { ref: 'x', name: 'Fine', ...future },
          { ref: 'y', name: 'Bad dates', startDate: '2099-02-01', endDate: '2099-01-01' },
        ],
        update: [{ task: t(9), set: { name: 'Nope' } }],
        link: [{ task: t(1), dependsOn: t(1) }],
      });
      expect(res.status).toBe(400);
      expect(codes(res.body.errors)).toEqual(['invalid_dates', 'self_link', 'unknown_task']);
      expect(res.body.errors.find((e: { code: string }) => e.code === 'unknown_task')).toMatchObject({
        at: 'update[0]',
        task: t(9),
      });

      const g = await snapshot(admin);
      expect(g).toMatchObject({ version: 1 });
      expect(g.tasks).toHaveLength(1);
      // The numbers were not used up either.
      expect((await batch(admin, { create: [{ ref: 'z', name: 'Z', ...future }] })).body.refs.z).toBe(t(2));
    });

    it('answers 409 when any problem is about the current state', async () => {
      const admin = await setup();
      await batch(admin, { create: [{ ref: 'a', name: 'A', ...future }] });
      await batch(admin, { update: [{ task: t(1), set: { status: 'in_progress' } }] });
      const res = await batch(admin, {
        update: [{ task: t(1), set: { status: 'not_started' } }],
        unlink: [{ task: t(1), dependsOn: t(5) }],
      });
      expect(res.status).toBe(409);
      expect(codes(res.body.errors)).toEqual(['status_back', 'unknown_task']);
    });

    it('rejects cycles, naming the path', async () => {
      const admin = await setup();
      await batch(admin, {
        create: ['a', 'b', 'c'].map((ref) => ({ ref, name: ref, ...future })),
        link: [
          { task: 'b', dependsOn: 'a' },
          { task: 'c', dependsOn: 'b' },
        ],
      });
      const res = await batch(admin, { link: [{ task: t(1), dependsOn: t(3) }] });
      expect(res.status).toBe(409);
      expect(res.body.errors).toEqual([
        {
          at: 'link[0]',
          code: 'cycle',
          message: `This would create a cycle: ${t(1)} → ${t(3)} → ${t(2)} → ${t(1)}`,
        },
      ]);
    });

    it('keeps the invariant: started tasks wait only on done tasks', async () => {
      const admin = await setup();
      await batch(admin, {
        create: ['a', 'b'].map((ref) => ({ ref, name: ref, ...future })),
        link: [{ task: 'b', dependsOn: 'a' }],
      });
      const start = await batch(admin, { update: [{ task: t(2), set: { status: 'in_progress' } }] });
      expect(start.status).toBe(409);
      expect(start.body.errors[0]).toMatchObject({ code: 'blocked', at: 'update[0]' });

      await batch(admin, {
        update: [
          { task: t(1), set: { status: 'done' } },
          { task: t(2), set: { status: 'in_progress' } },
        ],
      });
      const reopen = await batch(admin, { update: [{ task: t(1), set: { status: 'in_progress' } }] });
      expect(reopen.status).toBe(409);
      expect(reopen.body.errors[0].code).toBe('started_dependents');

      // Unlinking in the same batch makes it fine.
      const both = await batch(admin, {
        update: [{ task: t(1), set: { status: 'in_progress' } }],
        unlink: [{ task: t(2), dependsOn: t(1) }],
      });
      expect(both.status).toBe(200);
    });

    it('treats links as a set and drops items that change nothing, without a new version', async () => {
      const admin = await setup();
      await batch(admin, {
        create: ['a', 'b'].map((ref) => ({ ref, name: ref, ...future })),
        link: [{ task: 'b', dependsOn: 'a' }],
      });
      const res = await batch(admin, {
        link: [{ task: t(2), dependsOn: t(1) }],
        unlink: [{ task: t(1), dependsOn: t(2) }],
        update: [{ task: t(1), set: { name: 'a' } }],
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ version: 1, refs: {}, changes: [] });
    });

    it('removes a task with its links', async () => {
      const admin = await setup();
      await batch(admin, {
        create: ['a', 'b'].map((ref) => ({ ref, name: ref, ...future })),
        link: [{ task: 'b', dependsOn: 'a' }],
      });
      const res = await batch(admin, { remove: [t(1)] });
      expect(res.body.changes).toMatchObject([{ op: 'remove', task: t(1) }]);
      expect(await snapshot(admin)).toMatchObject({ version: 2, links: [], tasks: [{ code: t(2), isBlocked: false }] });

      const again = await batch(admin, { remove: [t(1)], update: [{ task: t(2), set: { name: 'b2' } }] });
      expect(again.status).toBe(400);
      expect(codes(again.body.errors)).toEqual(['unknown_task']);
    });

    it('refuses to touch a task the same batch removes, or to name one twice', async () => {
      const admin = await setup();
      await batch(admin, { create: ['a', 'b'].map((ref) => ({ ref, name: ref, ...future })) });
      const res = await batch(admin, {
        create: [
          { ref: 'n', name: 'n', ...future },
          { ref: 'n', name: 'n', ...future },
        ],
        remove: [t(1)],
        update: [
          { task: t(1), set: { name: 'x' } },
          { task: t(2), set: { name: 'x' } },
          { task: t(2), set: { name: 'y' } },
        ],
      });
      expect(codes(res.body.errors)).toEqual(['duplicate_item', 'duplicate_ref', 'removed_task']);
    });

    it('shows what a batch would do on a dry run, without saving it', async () => {
      const admin = await setup();
      const res = await batch(admin, { create: [{ ref: 'a', name: 'A', ...future }] }, '?dryRun=true');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ version: 0, refs: { a: t(1) }, changes: [{ op: 'create', version: 1 }] });
      expect(await snapshot(admin)).toMatchObject({ version: 0, tasks: [] });

      const bad = await batch(admin, { update: [{ task: t(1), set: { name: 'x' } }] }, '?dryRun=true');
      expect(bad.status).toBe(400);
    });

    it('caps a batch at 5000 items across all lists', async () => {
      const admin = await setup();
      const res = await batch(admin, {
        create: Array.from({ length: 2600 }, (_, i) => ({ ref: `r${i}`, name: 'x', ...future })),
        remove: Array.from({ length: 2600 }, () => t(1)),
      });
      expect(res.status).toBe(400);
      expect(res.body.errors).toMatchObject([{ code: 'too_large' }]);
    });

    it('validates the body: null fields, datetimes, unknown keys, refs that look like IDs', async () => {
      const admin = await setup();
      await batch(admin, { create: [{ ref: 'a', name: 'A', ...future }] });
      const bad = [
        { update: [{ task: t(1), set: { name: null } }] },
        { update: [{ task: t(1), set: { endDate: '2099-03-01T10:00:00Z' } }] },
        { update: [{ task: t(1), set: { status: 'late' } }] },
        { update: [{ task: t(1), set: { createdBy: 'me' } }] },
        { create: [{ ref: 'PRJ-0001-T-0009', name: 'x', ...future }] },
        { rename: [] },
      ];
      for (const body of bad) expect((await batch(admin, body)).status, JSON.stringify(body)).toBe(400);
    });
  });

  describe('conflicts', () => {
    async function twoUsers() {
      const admin = await setup();
      const other = await signUp(app);
      await addMember('PRJ-0001', other.id);
      await batch(admin, { create: [{ ref: 'a', name: 'Brickwork', ...future }] });
      return { admin, other };
    }

    it('lets the last write win when no values are expected', async () => {
      const { admin, other } = await twoUsers();
      await batch(admin, { update: [{ task: t(1), set: { name: 'Mine' } }] });
      expect((await batch(other, { update: [{ task: t(1), set: { name: 'Theirs' } }] })).status).toBe(200);
      expect((await snapshot(admin)).tasks[0].name).toBe('Theirs');
    });

    it('rejects a write over a value someone else changed since', async () => {
      const { admin, other } = await twoUsers();
      await batch(admin, { update: [{ task: t(1), set: { name: 'Mine' } }] });
      const res = await batch(other, {
        update: [{ task: t(1), set: { name: 'Theirs' }, expect: { name: 'Brickwork' } }],
      });
      expect(res.status).toBe(409);
      expect(res.body.errors).toMatchObject([{ code: 'conflict', at: 'update[0]', task: t(1) }]);
    });

    it('does not count it as a conflict when someone already made the same change', async () => {
      const { admin, other } = await twoUsers();
      await batch(admin, { update: [{ task: t(1), set: { status: 'in_progress' } }] });
      const res = await batch(other, {
        update: [{ task: t(1), set: { status: 'in_progress' }, expect: { status: 'not_started' } }],
      });
      expect(res.status).toBe(200);
      expect(res.body.changes).toEqual([]);
    });

    it('only checks the fields it expects, so edits to other fields merge', async () => {
      const { admin, other } = await twoUsers();
      await batch(admin, { update: [{ task: t(1), set: { endDate: '2099-03-01' } }] });
      const res = await batch(other, {
        update: [{ task: t(1), set: { name: 'Theirs' }, expect: { name: 'Brickwork' } }],
      });
      expect(res.status).toBe(200);
      expect((await snapshot(admin)).tasks[0]).toMatchObject({ name: 'Theirs', endDate: '2099-03-01' });
    });
  });

  describe('changelog', () => {
    it('logs every write, from batches and the single-task routes, with old and new values', async () => {
      const admin = await setup();
      await admin.post(url, { name: 'A', ...future }); // v1
      await admin.post(url, { name: 'B', ...future, dependsOn: [t(1)] }); // v2
      await admin.patch(`${url}/${t(1)}`, { name: 'A2' }); // v3
      await admin.post(`${url}/${t(1)}/start`); // v4
      await admin.delete(`${url}/${t(2)}/dependencies/${t(1)}`); // v5
      await admin.delete(`${url}/${t(2)}`); // v6

      const res = await admin.get(`${url}/changes?since=2`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ version: 6, hasMore: false });
      expect(res.body.changes).toMatchObject([
        { version: 3, op: 'update', task: t(1), data: { name: 'A2' }, prev: { name: 'A' }, by: admin.id },
        { version: 4, op: 'update', task: t(1), data: { status: 'in_progress' }, prev: { status: 'not_started' } },
        { version: 5, op: 'unlink', task: t(2), dependsOn: t(1) },
        { version: 6, op: 'remove', task: t(2) },
      ]);

      const all = await admin.get(`${url}/changes?since=0`);
      expect(all.body.changes.slice(0, 3)).toMatchObject([
        { version: 1, op: 'create', task: t(1), data: { name: 'A', status: 'not_started', ...future } },
        { version: 2, op: 'create', task: t(2) },
        { version: 2, op: 'link', task: t(2), dependsOn: t(1) },
      ]);
    });

    it('answers an up-to-date client with nothing, and refuses a version from the future', async () => {
      const admin = await setup();
      await admin.post(url, { name: 'A', ...future });
      expect((await admin.get(`${url}/changes?since=1`)).body).toEqual({ version: 1, hasMore: false, changes: [] });
      expect((await admin.get(`${url}/changes?since=2`)).status).toBe(400);
      expect((await admin.get(`${url}/changes?since=-1`)).status).toBe(400);
      expect((await admin.get(`${url}/changes`)).status).toBe(400);
    });

    it('pages by whole batches when far behind', async () => {
      const admin = await setup();
      const create = (from: number) => ({
        create: Array.from({ length: 3000 }, (_, i) => ({ ref: `r${from + i}`, name: 'x', ...future })),
      });
      await batch(admin, create(0)); // v1: 3000 changes
      await batch(admin, create(3000)); // v2: 3000 changes

      const first = await admin.get(`${url}/changes?since=0`);
      expect(first.body).toMatchObject({ version: 1, hasMore: true });
      expect(first.body.changes).toHaveLength(3000);
      const second = await admin.get(`${url}/changes?since=1`);
      expect(second.body).toMatchObject({ version: 2, hasMore: false });
      expect(second.body.changes).toHaveLength(3000);
    });

    it('trims old entries, and sends a client behind the trimmed log back to the snapshot', async () => {
      const admin = await setup();
      await admin.post(url, { name: 'A', ...future }); // v1
      await admin.post(url, { name: 'B', ...future }); // v2
      await pool.query(`UPDATE task_changes SET created_at = now() - interval '40 days' WHERE version = 1`);

      expect(await app.get(TaskChangesService).trim(30)).toBe(1);
      expect((await admin.get(`${url}/changes?since=0`)).status).toBe(410);
      expect((await admin.get(`${url}/changes?since=1`)).body.changes).toMatchObject([{ version: 2 }]);

      // Always a whole prefix: an old entry behind a newer kept one still goes.
      await admin.post(url, { name: 'C', ...future }); // v3
      await pool.query(`UPDATE task_changes SET created_at = now() - interval '40 days' WHERE version = 3`);
      expect(await app.get(TaskChangesService).trim(30)).toBe(2);
      expect((await admin.get(`${url}/changes?since=2`)).status).toBe(410);
      expect((await admin.get(`${url}/changes?since=3`)).status).toBe(200);
      expect((await snapshot(admin)).tasks).toHaveLength(3);
    });
  });

  describe('access', () => {
    it('answers 404 to non-members on the snapshot and changes routes', async () => {
      const admin = await setup();
      const outsider = await signUp(app);
      await batch(admin, { create: [{ ref: 'a', name: 'A', ...future }] });
      expect((await outsider.get(`${url}/snapshot`)).status).toBe(404);
      expect((await outsider.get(`${url}/changes?since=0`)).status).toBe(404);
      expect((await batch(outsider, { update: [{ task: t(1), set: { name: 'x' } }] })).status).toBe(404);
      expect((await snapshot(admin)).tasks[0].name).toBe('A');
    });
  });
});
