import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../src/db/migrate';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

// Starts a throwaway postgres in docker for the run, so the suite needs
// nothing running beforehand. Set TEST_DATABASE_URL to use an existing
// database instead (it gets dropped and recreated).
export default async function globalSetup(project: TestProject) {
  let container: StartedPostgreSqlContainer | undefined;
  let url = process.env.TEST_DATABASE_URL;

  if (url) {
    await recreateDatabase(url);
  } else {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    url = container.getConnectionUri();
  }

  process.env.DATABASE_URL = url;
  await runMigrations();
  project.provide('databaseUrl', url);

  return async () => {
    await container?.stop();
  };
}

async function recreateDatabase(connectionString: string) {
  const url = new URL(connectionString);
  const dbName = url.pathname.slice(1);
  url.pathname = '/postgres';

  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();
}
