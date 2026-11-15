import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { addMember, createTestApp, pool, resetDb, signUp } from './helpers';

describe('invitations', () => {
  let app: NestFastifyApplication;
  const project = { name: 'Riverside Tower', startDate: '2026-01-01', endDate: '2026-12-31' };
  const url = '/projects/PRJ-0001/invitations';

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
    const guest = await signUp(app, 'user', 'Guest');
    await admin.post('/projects', project);
    return { admin, guest };
  }

  describe('project side', () => {
    it('lets an admin invite and shows the pending invitation to every member', async () => {
      const { admin, guest } = await setup();
      const member = await signUp(app);
      await addMember('PRJ-0001', member.id);

      const res = await admin.post(url, { userId: guest.id });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        inviteeId: guest.id,
        inviteeName: 'Guest',
        invitedById: admin.id,
        invitedByName: 'Admin',
        status: 'pending',
      });

      const list = await member.get(url);
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);
    });

    it('forbids non-admin members from inviting or withdrawing', async () => {
      const { admin, guest } = await setup();
      const member = await signUp(app);
      await addMember('PRJ-0001', member.id);

      expect((await member.post(url, { userId: guest.id })).status).toBe(403);
      const { body } = await admin.post(url, { userId: guest.id });
      expect((await member.delete(`${url}/${body.id}`)).status).toBe(403);
    });

    it('answers 404 to non-members, as if the project did not exist', async () => {
      const { guest } = await setup();
      expect((await guest.get(url)).status).toBe(404);
      expect((await guest.post(url, { userId: guest.id })).status).toBe(404);
    });

    it('rejects inviting yourself, a member, an unknown user or a bad id', async () => {
      const { admin } = await setup();
      const member = await signUp(app);
      await addMember('PRJ-0001', member.id);

      expect((await admin.post(url, { userId: admin.id })).status).toBe(400);
      expect((await admin.post(url, { userId: member.id })).status).toBe(409);
      expect((await admin.post(url, { userId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
      expect((await admin.post(url, { userId: 'nope' })).status).toBe(400);
    });

    it('allows only one pending invitation per person, even under concurrent invites', async () => {
      const { admin, guest } = await setup();
      const results = await Promise.all(Array.from({ length: 10 }, () => admin.post(url, { userId: guest.id })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    });

    it('withdraws a pending invitation, hides it, and allows inviting again', async () => {
      const { admin, guest } = await setup();
      const { body } = await admin.post(url, { userId: guest.id });

      expect((await admin.delete(`${url}/${body.id}`)).status).toBe(204);
      expect((await admin.get(url)).body).toHaveLength(0);
      expect((await admin.delete(`${url}/${body.id}`)).status).toBe(409);
      expect((await admin.post(url, { userId: guest.id })).status).toBe(201);
    });

    it('lets any admin withdraw an invitation another admin sent', async () => {
      const { admin, guest } = await setup();
      const other = await signUp(app);
      await addMember('PRJ-0001', other.id, true);
      const { body } = await admin.post(url, { userId: guest.id });
      expect((await other.delete(`${url}/${body.id}`)).status).toBe(204);
    });

    it("cannot withdraw another project's invitation through this project", async () => {
      const { admin, guest } = await setup();
      await admin.post('/projects', project);
      const { body } = await admin.post('/projects/PRJ-0002/invitations', { userId: guest.id });
      expect((await admin.delete(`${url}/${body.id}`)).status).toBe(404);
    });

    it('withdraws pending invitations when the project is deleted', async () => {
      const { admin, guest } = await setup();
      await admin.post(url, { userId: guest.id });
      await admin.delete('/projects/PRJ-0001');
      const { rows } = await pool.query('SELECT status, answered_at FROM invitations');
      expect(rows).toEqual([{ status: 'withdrawn', answered_at: expect.any(Date) }]);
    });
  });

  describe('invitee side', () => {
    async function invited() {
      const { admin, guest } = await setup();
      const { body } = await admin.post(url, { userId: guest.id });
      return { admin, guest, id: body.id as number };
    }

    it('accepting joins the project and returns it', async () => {
      const { admin, guest, id } = await invited();
      const res = await guest.post(`/invitations/${id}/accept`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ code: 'PRJ-0001', isAdmin: false, memberCount: 2 });

      expect((await guest.get('/projects/PRJ-0001')).status).toBe(200);
      expect((await admin.get(url)).body).toHaveLength(0);
      expect((await guest.post(`/invitations/${id}/accept`)).status).toBe(409);
    });

    it('rejecting does not join and cannot be undone', async () => {
      const { guest, id } = await invited();
      expect((await guest.post(`/invitations/${id}/reject`)).status).toBe(204);
      expect((await guest.get('/projects/PRJ-0001')).status).toBe(404);
      expect((await guest.post(`/invitations/${id}/accept`)).status).toBe(409);
    });

    it("answers 404 to anyone but the invitee, even the project's admin", async () => {
      const { admin, id } = await invited();
      const stranger = await signUp(app);
      expect((await stranger.post(`/invitations/${id}/accept`)).status).toBe(404);
      expect((await admin.post(`/invitations/${id}/reject`)).status).toBe(404);
      expect((await stranger.post('/invitations/999/accept')).status).toBe(404);
    });

    it('cannot accept a withdrawn invitation', async () => {
      const { admin, guest, id } = await invited();
      await admin.delete(`${url}/${id}`);
      expect((await guest.post(`/invitations/${id}/accept`)).status).toBe(409);
    });

    it('cannot accept once the project is deleted, and hides it from the list', async () => {
      const { admin, guest, id } = await invited();
      await admin.delete('/projects/PRJ-0001');
      expect((await guest.post(`/invitations/${id}/accept`)).status).toBe(404);
      expect((await guest.get('/invitations')).body.items).toHaveLength(0);
    });

    it('a racing accept and withdraw never both succeed', async () => {
      for (let i = 0; i < 5; i++) {
        await resetDb();
        const { admin, guest, id } = await invited();
        const [accept, withdraw] = await Promise.all([
          guest.post(`/invitations/${id}/accept`),
          admin.delete(`${url}/${id}`),
        ]);
        const accepted = accept.status === 200;
        expect([accept.status, withdraw.status]).toEqual(accepted ? [200, 409] : [409, 204]);
        const members = await pool.query('SELECT count(*)::int AS n FROM project_members');
        expect(members.rows[0].n).toBe(accepted ? 2 : 1);
      }
    });

    it('lists my invitations newest first in every status, with project and inviter', async () => {
      const { admin, guest } = await setup();
      await admin.post('/projects', { ...project, name: 'Second' });
      const first = await admin.post(url, { userId: guest.id });
      await admin.post('/projects/PRJ-0002/invitations', { userId: guest.id });
      await guest.post(`/invitations/${first.body.id}/reject`);

      const res = await guest.get('/invitations');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total: 2, limit: 50, offset: 0 });
      expect(res.body.items).toMatchObject([
        { projectCode: 'PRJ-0002', projectName: 'Second', invitedByName: 'Admin', status: 'pending', answeredAt: null },
        { projectCode: 'PRJ-0001', status: 'rejected', answeredAt: expect.any(String) },
      ]);
      expect((await admin.get('/invitations')).body.items).toHaveLength(0);
    });

    it('pages with limit and offset', async () => {
      const { admin, guest } = await setup();
      for (let i = 0; i < 4; i++) await admin.post('/projects', project);
      for (let p = 1; p <= 5; p++) await admin.post(`/projects/PRJ-000${p}/invitations`, { userId: guest.id });

      const res = await guest.get('/invitations?limit=2&offset=2');
      expect(res.body).toMatchObject({ total: 5, limit: 2, offset: 2 });
      expect(res.body.items.map((i: { projectCode: string }) => i.projectCode)).toEqual(['PRJ-0003', 'PRJ-0002']);
    });

    it('counts unread pending invitations; listing marks the page read', async () => {
      const { admin, guest } = await setup();
      for (let i = 0; i < 2; i++) await admin.post('/projects', project);
      for (let p = 1; p <= 3; p++) await admin.post(`/projects/PRJ-000${p}/invitations`, { userId: guest.id });
      expect((await guest.get('/invitations/unread-count')).body).toEqual({ count: 3 });

      const page = await guest.get('/invitations?limit=2');
      expect(page.body.items.map((i: { readAt: unknown }) => i.readAt)).toEqual([null, null]);
      expect((await guest.get('/invitations/unread-count')).body).toEqual({ count: 1 });

      const again = await guest.get('/invitations?limit=2');
      expect(again.body.items.every((i: { readAt: unknown }) => typeof i.readAt === 'string')).toBe(true);
    });

    it('drops withdrawn and answered invitations from the unread count', async () => {
      const { admin, guest } = await setup();
      await admin.post('/projects', project);
      const a = await admin.post(url, { userId: guest.id });
      const b = await admin.post('/projects/PRJ-0002/invitations', { userId: guest.id });
      await admin.delete(`${url}/${a.body.id}`);
      await guest.post(`/invitations/${b.body.id}/reject`);
      expect((await guest.get('/invitations/unread-count')).body).toEqual({ count: 0 });
    });
  });
});
