import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

export async function createTestApp() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

// Direct DB access for setup the API doesn't expose yet (eg adding members
// before invitations exist) and for wiping state between tests.
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

export async function resetDb() {
  await pool.query('TRUNCATE users, projects RESTART IDENTITY CASCADE');
}

export async function addMember(code: string, userId: string, isAdmin = false) {
  await pool.query(
    `INSERT INTO project_members (project_id, user_id, admin_since)
     SELECT id, $2, CASE WHEN $3 THEN clock_timestamp() END FROM projects WHERE code = $1`,
    [code, userId, isAdmin],
  );
}

let ipCounter = 0;

type Cookie = { value: string; path: string };

// A fake browser: keeps its own cookie jar and its own IP so rate limits
// don't leak between test users.
export class TestClient {
  readonly cookies = new Map<string, Cookie>();
  readonly ip = `10.0.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

  constructor(private readonly app: NestFastifyApplication) {}

  async request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: object) {
    const cookies: Record<string, string> = {};
    for (const [name, c] of this.cookies) if (url.startsWith(c.path)) cookies[name] = c.value;

    const res = await this.app.inject({ method, url, payload: body, cookies, remoteAddress: this.ip });
    for (const c of res.cookies as Array<{ name: string; value: string; path?: string; maxAge?: number }>) {
      if (!c.value || c.maxAge === 0) this.cookies.delete(c.name);
      else this.cookies.set(c.name, { value: c.value, path: c.path ?? '/' });
    }
    return { status: res.statusCode, body: res.body ? res.json() : undefined, raw: res };
  }

  get = (url: string) => this.request('GET', url);
  post = (url: string, body?: object) => this.request('POST', url, body);
  patch = (url: string, body?: object) => this.request('PATCH', url, body);
  delete = (url: string) => this.request('DELETE', url);
}

type Role = 'user' | 'store_manager' | 'super_admin';

let userCounter = 0;

// Registers and logs in a fresh user, returns a client holding their cookies.
export async function signUp(app: NestFastifyApplication, role: Role = 'user', name?: string) {
  const n = ++userCounter;
  const creds = { email: `user${n}@sitetrack.test`, password: 'correct-horse-battery' };
  const client = new TestClient(app);
  const reg = await client.post('/auth/register', { name: name ?? `User ${n}`, role, ...creds });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  const login = await client.post('/auth/login', creds);
  if (login.status !== 204) throw new Error(`login failed: ${login.status}`);
  return Object.assign(client, { id: reg.body.id as string, ...creds });
}
