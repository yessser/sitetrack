import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { addMember, createTestApp, pool, resetDb, signUp } from './helpers';

describe('projects', () => {
  let app: NestFastifyApplication;
  const project = { name: 'Riverside Tower', startDate: '2026-01-01', endDate: '2026-12-31' };

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(resetDb);
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('create', () => {
    it('gives a PRJ code and makes the creator project admin', async () => {
      const owner = await signUp(app);
      const res = await owner.post('/projects', project);

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ code: 'PRJ-0001', isAdmin: true, memberCount: 1 });
      expect((await owner.post('/projects', project)).body.code).toBe('PRJ-0002');
    });

    it('never hands out the same code under concurrent creates', async () => {
      const owner = await signUp(app);
      const results = await Promise.all(Array.from({ length: 30 }, () => owner.post('/projects', project)));
      const codes = results.map((r) => r.body.code);
      expect(new Set(codes).size).toBe(30);
    });

    it('never reuses the code of a deleted project', async () => {
      const owner = await signUp(app);
      await owner.post('/projects', project);
      await owner.delete('/projects/PRJ-0001');
      expect((await owner.post('/projects', project)).body.code).toBe('PRJ-0002');
    });

    it('rejects an end date before the start date', async () => {
      const owner = await signUp(app);
      const res = await owner.post('/projects', { ...project, startDate: '2026-06-01', endDate: '2026-05-01' });
      expect(res.status).toBe(400);
    });
  });

  describe('access', () => {
    it('a non member gets the same 404 as a project that does not exist', async () => {
      const owner = await signUp(app);
      const outsider = await signUp(app);
      await owner.post('/projects', project);

      const real = await outsider.get('/projects/PRJ-0001');
      const fake = await outsider.get('/projects/PRJ-9999');
      expect(real.status).toBe(404);
      expect(real.body).toEqual(fake.body);
      expect((await outsider.get('/projects/PRJ-0001/members')).status).toBe(404);
      expect((await outsider.get('/projects')).body.total).toBe(0);
    });

    it('a regular member can read but gets 403 on admin actions', async () => {
      const owner = await signUp(app);
      const member = await signUp(app);
      await owner.post('/projects', project);
      await addMember('PRJ-0001', member.id);

      expect((await member.get('/projects/PRJ-0001')).body).toMatchObject({ isAdmin: false, memberCount: 2 });
      expect((await member.patch('/projects/PRJ-0001', { name: 'Hijacked' })).status).toBe(403);
      expect((await member.delete('/projects/PRJ-0001')).status).toBe(403);
      expect((await member.delete(`/projects/PRJ-0001/members/${owner.id}`)).status).toBe(403);
    });

    it('a superadmin sees and manages every project without being a member', async () => {
      const owner = await signUp(app);
      const admin = await signUp(app, 'super_admin');
      await owner.post('/projects', project);

      expect((await admin.get('/projects')).body.total).toBe(1);
      const patched = await admin.patch('/projects/PRJ-0001', { name: 'Renamed' });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ name: 'Renamed', isAdmin: false });
    });

    it('a removed member loses access on the very next request', async () => {
      const owner = await signUp(app);
      const member = await signUp(app);
      await owner.post('/projects', project);
      await addMember('PRJ-0001', member.id);

      expect((await owner.delete(`/projects/PRJ-0001/members/${member.id}`)).status).toBe(204);
      expect((await member.get('/projects/PRJ-0001')).status).toBe(404);
    });
  });

  describe('update and delete', () => {
    it('checks dates against the stored ones on partial updates', async () => {
      const owner = await signUp(app);
      await owner.post('/projects', project);
      expect((await owner.patch('/projects/PRJ-0001', { endDate: '2025-12-31' })).status).toBe(400);
    });

    it('a deleted project disappears from lists and returns 404', async () => {
      const owner = await signUp(app);
      await owner.post('/projects', project);

      expect((await owner.delete('/projects/PRJ-0001')).status).toBe(204);
      expect((await owner.get('/projects/PRJ-0001')).status).toBe(404);
      expect((await owner.get('/projects')).body.total).toBe(0);
    });
  });

  describe('members', () => {
    it('the last project admin cannot be removed', async () => {
      const owner = await signUp(app);
      const member = await signUp(app);
      await owner.post('/projects', project);
      await addMember('PRJ-0001', member.id);

      expect((await owner.delete(`/projects/PRJ-0001/members/${owner.id}`)).status).toBe(409);

      expect((await owner.post(`/projects/PRJ-0001/members/${member.id}/admin`)).status).toBe(204);
      expect((await owner.delete(`/projects/PRJ-0001/members/${owner.id}`)).status).toBe(204);
    });

    it('two admins leaving at once cannot leave the project without an admin', async () => {
      const a = await signUp(app);
      const b = await signUp(app);
      await a.post('/projects', project);
      await addMember('PRJ-0001', b.id, true);

      const results = await Promise.all([
        a.delete(`/projects/PRJ-0001/members/${a.id}`),
        b.delete(`/projects/PRJ-0001/members/${b.id}`),
      ]);
      const { rows } = await pool.query('SELECT count(*)::int AS admins FROM project_members WHERE admin_since IS NOT NULL');
      expect(rows[0].admins).toBe(1);
      expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
    });

    it('an admin can demote and remove admins appointed after them, not before', async () => {
      const senior = await signUp(app);
      const junior = await signUp(app);
      await senior.post('/projects', project);
      await addMember('PRJ-0001', junior.id, true);

      expect((await junior.delete(`/projects/PRJ-0001/members/${senior.id}/admin`)).status).toBe(403);
      expect((await junior.delete(`/projects/PRJ-0001/members/${senior.id}`)).status).toBe(403);

      expect((await senior.delete(`/projects/PRJ-0001/members/${junior.id}/admin`)).status).toBe(204);
      expect((await junior.get('/projects/PRJ-0001')).body.isAdmin).toBe(false);
    });

    it('re-promoting an admin keeps their seniority', async () => {
      const senior = await signUp(app);
      const junior = await signUp(app);
      await senior.post('/projects', project);
      await addMember('PRJ-0001', junior.id, true);

      expect((await junior.post(`/projects/PRJ-0001/members/${junior.id}/admin`)).status).toBe(204);
      expect((await junior.delete(`/projects/PRJ-0001/members/${senior.id}/admin`)).status).toBe(403);
    });

    it('a superadmin outranks every project admin', async () => {
      const owner = await signUp(app);
      const boss = await signUp(app, 'super_admin');
      const other = await signUp(app);
      await owner.post('/projects', project);
      await addMember('PRJ-0001', other.id, true);

      expect((await boss.delete(`/projects/PRJ-0001/members/${owner.id}/admin`)).status).toBe(204);
      expect((await boss.delete(`/projects/PRJ-0001/members/${owner.id}`)).status).toBe(204);
    });

    it('any member can leave, the last admin cannot step down', async () => {
      const owner = await signUp(app);
      const member = await signUp(app);
      await owner.post('/projects', project);
      await addMember('PRJ-0001', member.id);

      expect((await member.delete(`/projects/PRJ-0001/members/${member.id}`)).status).toBe(204);
      expect((await member.get('/projects/PRJ-0001')).status).toBe(404);
      expect((await owner.delete(`/projects/PRJ-0001/members/${owner.id}/admin`)).status).toBe(409);
    });

    it('a regular member cannot remove or demote others', async () => {
      const owner = await signUp(app);
      const member = await signUp(app);
      const other = await signUp(app);
      await owner.post('/projects', project);
      await addMember('PRJ-0001', member.id);
      await addMember('PRJ-0001', other.id);

      expect((await member.delete(`/projects/PRJ-0001/members/${other.id}`)).status).toBe(403);
      expect((await member.delete(`/projects/PRJ-0001/members/${owner.id}/admin`)).status).toBe(403);
    });

    it('lists admins first, by seniority', async () => {
      const owner = await signUp(app, 'user', 'Zed');
      const junior = await signUp(app, 'user', 'Ann');
      const member = await signUp(app, 'user', 'Abe');
      await owner.post('/projects', project);
      await addMember('PRJ-0001', member.id);
      await addMember('PRJ-0001', junior.id, true);

      const res = await owner.get('/projects/PRJ-0001/members');
      expect(res.body.map((m: any) => m.name)).toEqual(['Zed', 'Ann', 'Abe']);
      expect(res.body[2]).toMatchObject({ isAdmin: false, adminSince: null });
    });
  });

  describe('pagination', () => {
    it('pages with limit/offset and reports the total', async () => {
      const owner = await signUp(app);
      for (let i = 0; i < 5; i++) await owner.post('/projects', project);

      const res = await owner.get('/projects?limit=2&offset=2');
      expect(res.body).toMatchObject({ total: 5, limit: 2, offset: 2 });
      expect(res.body.items.map((p: any) => p.code)).toEqual(['PRJ-0003', 'PRJ-0004']);
    });

    it.each(['limit=0', 'limit=201', 'offset=-1', 'limit=abc'])('rejects %s', async (q) => {
      const owner = await signUp(app);
      expect((await owner.get(`/projects?${q}`)).status).toBe(400);
    });
  });
});
