import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ACCESS_COOKIE } from './auth/auth.config';

// Writes the OpenAPI spec to docs/openapi.json without starting a server or
// touching the database. Must run from the `nest build` output: the swagger
// CLI plugin only adds the DTO metadata at compile time.
async function generate() {
  process.env.JWT_SECRET ??= 'openapi-generation-only-not-a-real-secret';
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });

  const config = new DocumentBuilder()
    .setTitle('SiteTrack API')
    .setDescription(
      'Auth is cookie based: POST /auth/login sets httpOnly `access_token` and `refresh_token` cookies, ' +
        'POST /auth/refresh rotates them. Lists take `limit` (default 50, max 200) and `offset`.',
    )
    .setVersion('1.0')
    .addCookieAuth(ACCESS_COOKIE)
    .build();
  const document = SwaggerModule.createDocument(app, config);

  const out = path.join(__dirname, '../docs/openapi.json');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(document, null, 2) + '\n');
  await app.close();
  console.log(`wrote ${path.relative(process.cwd(), out)}`);
}

generate();
