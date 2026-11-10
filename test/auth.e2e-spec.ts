import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp, pool, resetDb, signUp, TestClient } from './helpers';

describe('auth', () => {
  let app: NestFastifyApplication;
  const creds = { name: 'Ana', email: 'ana@sitetrack.test', password: 'correct-horse-battery', role: 'user' };

  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(resetDb);
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('register', () => {
    it('creates the user and never returns the password hash', async () => {
      const res = await new TestClient(app).post('/auth/register', creds);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: 'Ana', email: 'ana@sitetrack.test', role: 'user' });
      expect(res.body).not.toHaveProperty('passwordHash');
    });

    it('rejects an email already taken, ignoring case', async () => {
      const client = new TestClient(app);
      await client.post('/auth/register', creds);
      const res = await client.post('/auth/register', { ...creds, email: 'ANA@SiteTrack.test' });
      expect(res.status).toBe(409);
    });

    it.each([
      ['unknown role', { ...creds, role: 'god' }],
      ['short password', { ...creds, password: 'short' }],
      ['bad email', { ...creds, email: 'nope' }],
      ['extra field', { ...creds, isAdmin: true }],
    ])('rejects %s with 400', async (_, body) => {
      expect((await new TestClient(app).post('/auth/register', body)).status).toBe(400);
    });
  });

  describe('login', () => {
    it('sets httpOnly cookies, the refresh one scoped to /auth', async () => {
      const client = new TestClient(app);
      await client.post('/auth/register', creds);
      const res = await client.post('/auth/login', { email: creds.email, password: creds.password });

      expect(res.status).toBe(204);
      const cookies = Object.fromEntries((res.raw.cookies as any[]).map((c) => [c.name, c]));
      expect(cookies.access_token).toMatchObject({ httpOnly: true, path: '/', sameSite: 'Lax' });
      expect(cookies.refresh_token).toMatchObject({ httpOnly: true, path: '/auth', sameSite: 'Strict' });
    });

    it('gives the same answer for a wrong password and an unknown email', async () => {
      const client = new TestClient(app);
      await client.post('/auth/register', creds);
      const wrongPassword = await client.post('/auth/login', { email: creds.email, password: 'wrong-password' });
      const unknownEmail = await client.post('/auth/login', { email: 'ghost@sitetrack.test', password: 'whatever1' });

      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      expect(wrongPassword.body.message).toBe(unknownEmail.body.message);
    });

    it('is rate limited per IP after 10 attempts a minute', async () => {
      const client = new TestClient(app);
      const statuses = [];
      for (let i = 0; i < 11; i++) {
        statuses.push((await client.post('/auth/login', { email: 'x@sitetrack.test', password: 'whatever1' })).status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
    });
  });

  describe('session', () => {
    it('/me needs a logged in user', async () => {
      expect((await new TestClient(app).get('/me')).status).toBe(401);
    });

    it('/me returns the own profile', async () => {
      const user = await signUp(app, 'store_manager');
      const res = await user.get('/me');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: user.id, email: user.email, role: 'store_manager' });
      expect(res.body).not.toHaveProperty('passwordHash');
    });

    it('refresh rotates the tokens and the old refresh token stops working', async () => {
      const user = await signUp(app);
      const oldRefresh = user.cookies.get('refresh_token')!.value;

      expect((await user.post('/auth/refresh')).status).toBe(204);
      expect(user.cookies.get('refresh_token')!.value).not.toBe(oldRefresh);
      expect((await user.get('/me')).status).toBe(200);

      const replay = new TestClient(app);
      replay.cookies.set('refresh_token', { value: oldRefresh, path: '/auth' });
      expect((await replay.post('/auth/refresh')).status).toBe(401);
    });

    it('logout kills the session on the very next request', async () => {
      const user = await signUp(app);
      const { access_token, refresh_token } = Object.fromEntries(user.cookies);

      expect((await user.post('/auth/logout')).status).toBe(204);

      const stolen = new TestClient(app);
      stolen.cookies.set('access_token', access_token);
      stolen.cookies.set('refresh_token', refresh_token);
      expect((await stolen.get('/me')).status).toBe(401);
      expect((await stolen.post('/auth/refresh')).status).toBe(401);
    });

    it('a role change applies on the very next request', async () => {
      const user = await signUp(app);
      await pool.query(`UPDATE users SET role = 'super_admin' WHERE id = $1`, [user.id]);
      expect((await user.get('/me')).body.role).toBe('super_admin');
    });
  });
});
