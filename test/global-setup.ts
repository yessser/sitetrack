import { Client } from 'pg';
import { runMigrations } from '../src/db/migrate';
import { TEST_DATABASE_URL } from './env';

// Recreates the test database from scratch and runs the real migrations once
// per test run.
export default async function globalSetup() {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  url.pathname = '/postgres';

  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  await runMigrations();
}
