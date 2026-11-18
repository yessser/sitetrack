import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { addMember, createTestApp, pool, resetDb, signUp } from './helpers';

describe('tasks', () => {
  let app: NestFastifyApplication;
  const project = { name: 'Riverside Tower', startDate: '2026-01-01', endDate: '2099-12-31' };
  const url = '/projects/PRJ-0001/tasks';
  // Far future: never late. Far past: always late.
  const future = { startDate: '2099-01-01', endDate: '2099-02-01' };
  const past = { startDate: '2020-01-01', endDate: '2020-02-01' };

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

  describe('ids', () => {
    it('numbers tasks within their project, starting at T-0001 in each', async () => {
      const admin = await setup();
      await admin.post('/projects', project);

      const a = await admin.post(url, { name: 'Excavation', ...future });
      expect(a.status).toBe(201);
      expect(a.body).toMatchObject({ code: 'PRJ-0001-T-0001', name: 'Excavation', status: 'not_started' });
      expect((await admin.post(url, { name: 'Footings', ...future })).body.code).toBe('PRJ-0001-T-0002');
      expect((await admin.post('/projects/PRJ-0002/tasks', { name: 'Survey', ...future })).body.code).toBe(
        'PRJ-0002-T-0001',
      );
    });

    it('never hands out the same number twice, even under concurrent creates', async () => {
      const admin = await setup();
      const results = await Promise.all(
        Array.from({ length: 25 }, (_, i) => admin.post(url, { name: `Task ${i}`, ...future })),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      const codes = results.map((r) => r.body.code).sort();
      expect(codes).toEqual(Array.from({ length: 25 }, (_, i) => `PRJ-0001-T-${String(i + 1).padStart(4, '0')}`));
    });

    it('does not reuse the number of a removed task', async () => {
      const admin = await setup();
      await admin.post(url, { name: 'One', ...future });
      await admin.post(url, { name: 'Two', ...future });
      expect((await admin.delete(`${url}/PRJ-0001-T-0002`)).status).toBe(204);
      expect((await admin.post(url, { name: 'Three', ...future })).body.code).toBe('PRJ-0001-T-0003');
    });

    it('does not consume a number when the create fails', async () => {
      const admin = await setup();
      expect((await admin.post(url, { name: 'Bad', startDate: '2099-02-01', endDate: '2099-01-01' })).status).toBe(400);
      expect((await admin.post(url, { name: 'Good', ...future })).body.code).toBe('PRJ-0001-T-0001');
    });
  });

  describe('access', () => {
    it('lets every member work with tasks, not only admins', async () => {
      const admin = await setup();
      const member = await signUp(app);
      await addMember('PRJ-0001', member.id);

      const created = await member.post(url, { name: 'Formwork', ...future });
      expect(created.status).toBe(201);
      expect((await member.patch(`${url}/${created.body.code}`, { name: 'Formwork L1' })).status).toBe(200);
      expect((await member.post(`${url}/${created.body.code}/start`)).status).toBe(200);
      expect((await admin.get(`${url}/${created.body.code}`)).body.status).toBe('in_progress');
    });

    it('answers 404 to non-members on every task route', async () => {
      const admin = await setup();
      const outsider = await signUp(app);
      await admin.post(url, { name: 'Secret', ...future });
      const task = `${url}/PRJ-0001-T-0001`;

      expect((await outsider.get(url)).status).toBe(404);
      expect((await outsider.post(url, { name: 'x', ...future })).status).toBe(404);
      expect((await outsider.get(task)).status).toBe(404);
      expect((await outsider.patch(task, { name: 'x' })).status).toBe(404);
      expect((await outsider.post(`${task}/start`)).status).toBe(404);
      expect((await outsider.delete(task)).status).toBe(404);
      expect((await outsider.post(`${task}/dependencies`, { dependsOn: 'PRJ-0001-T-0001' })).status).toBe(404);
      expect((await outsider.delete(`${task}/dependencies/PRJ-0001-T-0001`)).status).toBe(404);
    });

    it('lets a SuperAdmin reach tasks of any project', async () => {
      const admin = await setup();
      const boss = await signUp(app, 'super_admin');
      await admin.post(url, { name: 'Roofing', ...future });
      expect((await boss.get(`${url}/PRJ-0001-T-0001`)).status).toBe(200);
    });

    it("does not reach another project's task through a project the caller can see", async () => {
      const admin = await setup();
      const other = await signUp(app);
      await other.post('/projects', project);
      await other.post('/projects/PRJ-0002/tasks', { name: 'Theirs', ...future });

      expect((await admin.get(`${url}/PRJ-0002-T-0001`)).status).toBe(404);
    });

    it('stops reaching tasks once removed from the project', async () => {
      const admin = await setup();
      const member = await signUp(app);
      await addMember('PRJ-0001', member.id);
      await admin.post(url, { name: 'Scaffold', ...future });
      expect((await member.get(url)).status).toBe(200);

      await admin.delete(`/projects/PRJ-0001/members/${member.id}`);
      expect((await member.get(url)).status).toBe(404);
    });

    it('hides tasks of a removed project', async () => {
      const admin = await setup();
      await admin.post(url, { name: 'Scaffold', ...future });
      await admin.delete('/projects/PRJ-0001');
      expect((await admin.get(`${url}/PRJ-0001-T-0001`)).status).toBe(404);
    });
  });

  describe('crud', () => {
    it('edits name and dates and validates the merged date range', async () => {
      const admin = await setup();
      const { body } = await admin.post(url, { name: 'Brickwork', ...future });
      const task = `${url}/${body.code}`;

      const res = await admin.patch(task, { name: 'Brickwork L2', endDate: '2099-03-01' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ name: 'Brickwork L2', startDate: '2099-01-01', endDate: '2099-03-01' });
      expect((await admin.patch(task, { endDate: '2098-01-01' })).status).toBe(400);
    });

    it('rejects setting status through edit', async () => {
      const admin = await setup();
      const { body } = await admin.post(url, { name: 'Brickwork', ...future });
      expect((await admin.patch(`${url}/${body.code}`, { status: 'done' })).status).toBe(400);
    });

    it('treats task codes as exact match', async () => {
      const admin = await setup();
      await admin.post(url, { name: 'Brickwork', ...future });
      expect((await admin.get(`${url}/prj-0001-t-0001`)).status).toBe(404);
      expect((await admin.get(`${url}/PRJ-0001-T-1`)).status).toBe(404);
    });

    it('removes a task so it no longer shows anywhere', async () => {
      const admin = await setup();
      await admin.post(url, { name: 'Brickwork', ...future });
      await admin.delete(`${url}/PRJ-0001-T-0001`);
      expect((await admin.get(`${url}/PRJ-0001-T-0001`)).status).toBe(404);
      expect((await admin.get(url)).body.total).toBe(0);
      expect((await admin.delete(`${url}/PRJ-0001-T-0001`)).status).toBe(404);
    });
  });

  describe('status', () => {
    it('walks not started → in progress → done → in progress, with the allowed actions each time', async () => {
      const admin = await setup();
      const { body } = await admin.post(url, { name: 'Pour slab', ...future });
      expect(body.allowedActions).toEqual(['start']);
      const task = `${url}/${body.code}`;

      const started = await admin.post(`${task}/start`);
      expect(started.body).toMatchObject({ status: 'in_progress', allowedActions: ['done'] });
      const done = await admin.post(`${task}/done`);
      expect(done.body).toMatchObject({ status: 'done', allowedActions: ['reopen'] });
      const reopened = await admin.post(`${task}/reopen`);
      expect(reopened.body).toMatchObject({ status: 'in_progress', allowedActions: ['done'] });
    });

    it('rejects any other status change with 409', async () => {
      const admin = await setup();
      const { body } = await admin.post(url, { name: 'Pour slab', ...future });
      const task = `${url}/${body.code}`;

      expect((await admin.post(`${task}/done`)).status).toBe(409);
      expect((await admin.post(`${task}/reopen`)).status).toBe(409);
      await admin.post(`${task}/start`);
      expect((await admin.post(`${task}/start`)).status).toBe(409);
      expect((await admin.post(`${task}/reopen`)).status).toBe(409);
      await admin.post(`${task}/done`);
      expect((await admin.post(`${task}/start`)).status).toBe(409);
      expect((await admin.post(`${task}/done`)).status).toBe(409);
    });

    it('lets only one of several concurrent starts win', async () => {
      const admin = await setup();
      const { body } = await admin.post(url, { name: 'Pour slab', ...future });
      const results = await Promise.all(Array.from({ length: 8 }, () => admin.post(`${url}/${body.code}/start`)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    });
  });

  describe('late', () => {
    it('derives late from the dates and the status', async () => {
      const admin = await setup();
      const today = new Date().toISOString().slice(0, 10);
      const notStartedPastStart = await admin.post(url, { name: 'a', startDate: '2020-01-01', endDate: '2099-01-01' });
      const inProgressPastStart = await admin.post(url, { name: 'b', startDate: '2020-01-01', endDate: '2099-01-01' });
      const pastEnd = await admin.post(url, { name: 'c', ...past });
      const onTime = await admin.post(url, { name: 'd', ...future });
      const startsToday = await admin.post(url, { name: 'e', startDate: today, endDate: '2099-01-01' });

      expect(notStartedPastStart.body.isLate).toBe(true);
      expect((await admin.post(`${url}/${inProgressPastStart.body.code}/start`)).body.isLate).toBe(false);
      expect(pastEnd.body.isLate).toBe(true);
      expect(onTime.body.isLate).toBe(false);
      expect(startsToday.body.isLate).toBe(false);

      // Done is never late, even past its end date.
      await admin.post(`${url}/${pastEnd.body.code}/start`);
      expect((await admin.post(`${url}/${pastEnd.body.code}/done`)).body.isLate).toBe(false);
    });
  });

  describe('list', () => {
    async function seed() {
      const admin = await setup();
      await admin.post(url, { name: 'Excavation', ...past }); // T-0001 late
      await admin.post(url, { name: 'Pour slab', startDate: '2099-03-01', endDate: '2099-03-10' }); // T-0002
      await admin.post(url, { name: 'Brickwork', startDate: '2099-05-01', endDate: '2099-06-01' }); // T-0003
      await admin.post(`${url}/PRJ-0001-T-0002/start`);
      return admin;
    }
    const codes = (res: { body: { items: { code: string }[] } }) => res.body.items.map((t) => t.code.slice(-4));

    it('lists tasks by ID with paging and a total', async () => {
      const admin = await seed();
      const res = await admin.get(`${url}?limit=2`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total: 3, limit: 2, offset: 0 });
      expect(codes(res)).toEqual(['0001', '0002']);
      expect(res.body.items[0]).toMatchObject({ name: 'Excavation', status: 'not_started', isLate: true });
    });

    it('filters by status and late', async () => {
      const admin = await seed();
      expect(codes(await admin.get(`${url}?status=in_progress`))).toEqual(['0002']);
      expect(codes(await admin.get(`${url}?late=true`))).toEqual(['0001']);
      expect(codes(await admin.get(`${url}?late=false`))).toEqual(['0002', '0003']);
      expect((await admin.get(`${url}?status=late`)).status).toBe(400);
      expect((await admin.get(`${url}?late=yes`)).status).toBe(400);
    });

    it('filters by planned dates overlapping a range', async () => {
      const admin = await seed();
      expect(codes(await admin.get(`${url}?from=2099-03-05&to=2099-05-15`))).toEqual(['0002', '0003']);
      expect(codes(await admin.get(`${url}?to=2099-01-01`))).toEqual(['0001']);
      expect(codes(await admin.get(`${url}?from=2099-04-01`))).toEqual(['0003']);
    });

    it('searches by name or ID, case-insensitively, treating wildcards literally', async () => {
      const admin = await seed();
      expect(codes(await admin.get(`${url}?q=SLAB`))).toEqual(['0002']);
      expect(codes(await admin.get(`${url}?q=t-0003`))).toEqual(['0003']);
      expect(codes(await admin.get(`${url}?q=%25`))).toEqual([]);
    });

    it('sorts by name, dates or ID in either direction', async () => {
      const admin = await seed();
      expect(codes(await admin.get(`${url}?sort=name`))).toEqual(['0003', '0001', '0002']);
      expect(codes(await admin.get(`${url}?sort=endDate&order=desc`))).toEqual(['0003', '0002', '0001']);
      expect(codes(await admin.get(`${url}?order=desc`))).toEqual(['0003', '0002', '0001']);
      expect((await admin.get(`${url}?sort=status`)).status).toBe(400);
    });
  });

  describe('dependencies', () => {
    const t = (n: number) => `PRJ-0001-T-${String(n).padStart(4, '0')}`;
    const at = (n: number) => `${url}/${t(n)}`;
    type Client = Awaited<ReturnType<typeof signUp>>;

    // Creates `count` tasks, then links each pair [task, dependsOn] given by number.
    async function graph(count: number, links: [number, number][] = []) {
      const admin = await setup();
      for (let i = 1; i <= count; i++) await admin.post(url, { name: `Task ${i}`, ...future });
      for (const [a, b] of links) {
        const res = await admin.post(`${at(a)}/dependencies`, { dependsOn: t(b) });
        if (res.status !== 201) throw new Error(`link ${a}->${b}: ${res.status} ${JSON.stringify(res.body)}`);
      }
      return admin;
    }
    const finish = async (admin: Client, n: number) => {
      expect((await admin.post(`${at(n)}/start`)).status).toBe(200);
      expect((await admin.post(`${at(n)}/done`)).status).toBe(200);
    };
    const links = (res: { body: Record<string, unknown> }, key: 'waitsOn' | 'waitedBy' = 'waitsOn') =>
      (res.body[key] as { code: string; steps: number }[]).map((l) => `${l.code.slice(-4)}:${l.steps}`);

    it('links tasks on create and through the dependencies route, shown in details and the list', async () => {
      const admin = await graph(2);
      const c = await admin.post(url, { name: 'Slab', ...future, dependsOn: [t(2), t(1)] });
      expect(c.status).toBe(201);
      expect(c.body).toMatchObject({ dependsOn: [t(1), t(2)], dependentsCount: 0, isBlocked: true });

      const added = await admin.post(`${at(2)}/dependencies`, { dependsOn: t(1) });
      expect(added.status).toBe(201);
      expect(added.body).toMatchObject({ dependsOn: [t(1)], dependentsCount: 1 });

      const list = await admin.get(url);
      expect(
        list.body.items.map((i: { dependsOn: string[]; dependentsCount: number }) => [i.dependsOn, i.dependentsCount]),
      ).toEqual([
        [[], 2],
        [[t(1)], 1],
        [[t(1), t(2)], 0],
      ]);
    });

    it('rejects bad links: itself, unknown or foreign tasks, duplicates', async () => {
      const admin = await graph(2, [[2, 1]]);
      await admin.post('/projects', project);
      await admin.post('/projects/PRJ-0002/tasks', { name: 'Elsewhere', ...future });

      expect((await admin.post(`${at(1)}/dependencies`, { dependsOn: t(1) })).status).toBe(400);
      expect((await admin.post(`${at(1)}/dependencies`, { dependsOn: t(9) })).status).toBe(400);
      expect((await admin.post(`${at(1)}/dependencies`, { dependsOn: 'PRJ-0002-T-0001' })).status).toBe(400);
      expect((await admin.post(`${at(1)}/dependencies`, {})).status).toBe(400);
      expect((await admin.post(`${at(2)}/dependencies`, { dependsOn: t(1) })).status).toBe(409);
      expect((await admin.post(url, { name: 'x', ...future, dependsOn: [t(1), t(1)] })).status).toBe(400);
      expect((await admin.post(url, { name: 'x', ...future, dependsOn: ['PRJ-0002-T-0001'] })).status).toBe(400);
    });

    it('rejects links that would make a task wait on itself, directly or through others', async () => {
      // 3 -> 2 -> 1
      const admin = await graph(3, [
        [2, 1],
        [3, 2],
      ]);
      expect((await admin.post(`${at(1)}/dependencies`, { dependsOn: t(2) })).status).toBe(409);
      const res = await admin.post(`${at(1)}/dependencies`, { dependsOn: t(3) });
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/cycle/);
      // A diamond is not a cycle.
      expect((await admin.post(`${at(3)}/dependencies`, { dependsOn: t(1) })).status).toBe(201);
    });

    it('blocks a chain until everything it waits on is done', async () => {
      // 3 -> 2 -> 1
      const admin = await graph(3, [
        [2, 1],
        [3, 2],
      ]);
      const blocked = async () =>
        (await admin.get(`${url}?blocked=true`)).body.items.map((i: { code: string }) => i.code.slice(-4));

      expect(await blocked()).toEqual(['0002', '0003']);
      const c = await admin.get(at(3));
      expect(c.body).toMatchObject({ isBlocked: true, allowedActions: [] });
      expect((await admin.post(`${at(3)}/start`)).status).toBe(409);
      expect((await admin.post(`${at(2)}/start`)).status).toBe(409);

      await admin.post(`${at(1)}/start`);
      expect(await blocked()).toEqual(['0002', '0003']);
      await admin.post(`${at(1)}/done`);
      expect(await blocked()).toEqual(['0003']);
      expect((await admin.get(at(2))).body.allowedActions).toEqual(['start']);
      await finish(admin, 2);
      expect(await blocked()).toEqual([]);
      expect((await admin.post(`${at(3)}/start`)).status).toBe(200);
      expect((await admin.get(`${url}?blocked=false`)).body.total).toBe(3);
    });

    it('waits on side-by-side dependencies until all of them are done', async () => {
      const admin = await graph(3, [
        [3, 1],
        [3, 2],
      ]);
      await finish(admin, 1);
      expect((await admin.get(at(3))).body.isBlocked).toBe(true);
      expect((await admin.post(`${at(3)}/start`)).status).toBe(409);
      await finish(admin, 2);
      expect((await admin.post(`${at(3)}/start`)).status).toBe(200);
    });

    it('reopens only while nothing that waits on it has started', async () => {
      const admin = await graph(3, [
        [2, 1],
        [3, 2],
      ]);
      await finish(admin, 1);
      expect((await admin.get(at(1))).body.allowedActions).toEqual(['reopen']);
      expect((await admin.post(`${at(1)}/reopen`)).status).toBe(200);
      await admin.post(`${at(1)}/done`);

      await admin.post(`${at(2)}/start`);
      expect((await admin.get(at(1))).body.allowedActions).toEqual([]);
      const res = await admin.post(`${at(1)}/reopen`);
      expect(res.status).toBe(409);
      expect((await admin.get(at(1))).body.status).toBe('done');
    });

    it('only lets a started task depend on tasks that are done', async () => {
      const admin = await graph(3);
      await admin.post(`${at(2)}/start`);
      expect((await admin.post(`${at(2)}/dependencies`, { dependsOn: t(1) })).status).toBe(409);
      await finish(admin, 3);
      const res = await admin.post(`${at(2)}/dependencies`, { dependsOn: t(3) });
      expect(res.status).toBe(201);
      expect(res.body.isBlocked).toBe(false);
    });

    it('drops the links of a removed task, so nothing keeps waiting on it', async () => {
      const admin = await graph(3, [
        [2, 1],
        [3, 2],
      ]);
      expect((await admin.delete(at(2))).status).toBe(204);
      expect((await admin.get(at(3))).body).toMatchObject({ dependsOn: [], isBlocked: false, waitsOn: [] });
      expect((await admin.get(at(1))).body).toMatchObject({ dependentsCount: 0, waitedBy: [] });
    });

    it('removes a single link', async () => {
      const admin = await graph(2, [[2, 1]]);
      expect((await admin.delete(`${at(2)}/dependencies/${t(1)}`)).status).toBe(204);
      expect((await admin.get(at(2))).body).toMatchObject({ dependsOn: [], isBlocked: false });
      expect((await admin.delete(`${at(2)}/dependencies/${t(1)}`)).status).toBe(404);
      expect((await admin.delete(`${at(1)}/dependencies/${t(2)}`)).status).toBe(404);
    });

    it('shows everything a task waits on and everything waiting on it, by fewest steps', async () => {
      // 4 -> 3 -> 2 -> 1, plus the shortcut 4 -> 1, and 5 -> 4.
      const admin = await graph(5, [
        [2, 1],
        [3, 2],
        [4, 3],
        [4, 1],
        [5, 4],
      ]);
      const four = await admin.get(at(4));
      expect(links(four)).toEqual(['0001:1', '0003:1', '0002:2']);
      expect(links(four, 'waitedBy')).toEqual(['0005:1']);
      expect(four.body.waitsOn[0]).toEqual({ code: t(1), name: 'Task 1', status: 'not_started', steps: 1 });

      const one = await admin.get(at(1));
      expect(links(one)).toEqual([]);
      expect(links(one, 'waitedBy')).toEqual(['0002:1', '0004:1', '0003:2', '0005:2']);
    });

    it('sorts by the number of direct dependents', async () => {
      const admin = await graph(4, [
        [2, 1],
        [3, 1],
        [4, 3],
      ]);
      const order = async (q: string) =>
        (await admin.get(`${url}?sort=dependents&${q}`)).body.items.map((i: { code: string }) => i.code.slice(-4));
      expect(await order('order=desc')).toEqual(['0001', '0003', '0004', '0002']);
      expect(await order('order=asc')).toEqual(['0002', '0004', '0003', '0001']);
    });

    it('accepts only one of two opposite links added at the same time', async () => {
      const admin = await graph(2);
      for (let round = 0; round < 5; round++) {
        const [a, b] = await Promise.all([
          admin.post(`${at(1)}/dependencies`, { dependsOn: t(2) }),
          admin.post(`${at(2)}/dependencies`, { dependsOn: t(1) }),
        ]);
        expect([a.status, b.status].sort()).toEqual([201, 409]);
        await admin.delete(`${at(1)}/dependencies/${t(2)}`);
        await admin.delete(`${at(2)}/dependencies/${t(1)}`);
      }
    });

    it('never lets a start and a reopen race past each other', async () => {
      const admin = await graph(2, [[2, 1]]);
      await finish(admin, 1);
      for (let round = 0; round < 5; round++) {
        const [reopen, start] = await Promise.all([admin.post(`${at(1)}/reopen`), admin.post(`${at(2)}/start`)]);
        expect([reopen.status, start.status].sort()).toEqual([200, 409]);
        // Back to: 1 done, 2 not started.
        await pool.query(
          `UPDATE tasks SET status = CASE number WHEN 1 THEN 'done' ELSE 'not_started' END::task_status`,
        );
      }
    });
  });
});
